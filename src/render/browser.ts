import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { IpynbError } from '../core/errors.js';

export interface BrowserRenderOptions {
  readonly executable: string;
  readonly htmlPath: string;
  readonly profilePath: string;
  readonly format: 'pdf' | 'png';
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly onWarning: (message: string) => void;
  readonly onSpawn?: (pid: number) => void;
}

/** CDP over inherited pipes avoids opening a port or sharing an existing browser. */
class BrowserPipe {
  readonly #pending = new Map<number, { method: string; resolve: (value: Record<string, unknown>) => void; reject: (cause: unknown) => void }>();
  readonly #input: Writable;
  #buffer = Buffer.alloc(0);
  #nextId = 0;
  #failure: IpynbError | undefined;

  constructor(child: ChildProcess) {
    const input = child.stdio[3];
    const output = child.stdio[4];
    if (!(input instanceof Writable) || !(output instanceof Readable)) {
      throw new IpynbError('internal', 'browser debugging pipes are unavailable');
    }
    this.#input = input;
    input.on('error', () => this.fail(new IpynbError('internal', 'browser debugging input closed')));
    output.on('data', (chunk: Buffer) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      if (this.#buffer.length > 128 * 1024 * 1024) {
        this.fail(new IpynbError('internal', 'browser response exceeded the export size limit'));
        return;
      }
      let end: number;
      while ((end = this.#buffer.indexOf(0)) !== -1) {
        const packet = this.#buffer.subarray(0, end);
        this.#buffer = this.#buffer.subarray(end + 1);
        try {
          const message = JSON.parse(packet.toString('utf8')) as { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
          if (message.id !== undefined) {
            const pending = this.#pending.get(message.id);
            this.#pending.delete(message.id);
            if (message.error !== undefined) {
              pending?.reject(new IpynbError('internal', 'browser could not render the static export', { reason: message.error.message ?? 'CDP command failed' }));
            } else {
              pending?.resolve(message.result ?? {});
            }
          }
        } catch {
          this.fail(new IpynbError('internal', 'browser returned an invalid debugging frame'));
        }
      }
    });
    child.on('error', () => this.fail(new IpynbError('internal', 'could not start the export browser')));
    child.on('exit', () => this.fail(new IpynbError('internal', 'export browser exited before rendering finished')));
    output.on('error', () => this.fail(new IpynbError('internal', 'browser debugging output closed')));
  }

  fail(cause: IpynbError): void {
    this.#failure ??= cause;
    for (const entry of this.#pending.values()) {
      entry.reject(this.#failure);
    }
    this.#pending.clear();
  }

  pendingCommand(): string {
    return this.#pending.values().next().value?.method ?? 'document readiness';
  }

  async send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    if (this.#failure !== undefined) {
      throw this.#failure;
    }
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { method, resolve, reject });
      this.#input.write(`${JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) })}\0`);
    });
  }
}

async function killBrowserTree(child: ChildProcess, warn: (message: string) => void): Promise<void> {
  if (child.pid === undefined) {
    return;
  }
  if (process.platform === 'win32') {
    const pid = child.pid;
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true, timeout: 5000 });
      killer.once('error', (cause) => {
        warn(`could not stop export browser process tree: ${cause.message}`);
        child.kill();
        resolve();
      });
      killer.once('close', () => resolve());
    });
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (cause) {
      if (!(typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ESRCH')) {
        warn(`could not stop export browser process group: ${String(cause)}`);
        child.kill('SIGKILL');
      }
    }
  }
}

export async function renderWithBrowser(options: BrowserRenderOptions): Promise<Uint8Array> {
  if (options.signal?.aborted) {
    throw new IpynbError('cancelled', 'notebook export was cancelled');
  }
  const child = spawn(options.executable, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--remote-debugging-pipe',
    '--disable-background-networking', '--disable-extensions', '--disable-component-update',
    '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-default-apps',
    '--disable-client-side-phishing-detection', '--disable-domain-reliability',
    '--disable-breakpad', '--disable-crash-reporter', '--metrics-recording-only',
    '--disable-features=MediaRouter,OptimizationHints,Translate',
    '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND',
    `--user-data-dir=${options.profilePath}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  const pipe = new BrowserPipe(child);
  const onExit = () => {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true, timeout: 5000 });
    } else {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (cause) {
        options.onWarning(`could not stop export browser during server exit: ${String(cause)}`);
      }
    }
  };
  process.once('exit', onExit);
  const abort = () => pipe.fail(new IpynbError('cancelled', 'notebook export was cancelled'));
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) {
    abort();
  }
  const timer = setTimeout(() => pipe.fail(new IpynbError('exec_timeout', 'notebook export exceeded the browser rendering timeout', { command: pipe.pendingCommand() })), options.timeoutMs ?? 60_000);
  try {
    if (child.pid !== undefined) {
      options.onSpawn?.(child.pid);
    }
    const target = await pipe.send('Target.createTarget', { url: 'about:blank' });
    const attached = await pipe.send('Target.attachToTarget', { targetId: target['targetId'], flatten: true });
    const sessionId = attached['sessionId'];
    if (typeof sessionId !== 'string') {
      throw new IpynbError('internal', 'browser did not create an export session');
    }
    const send = (method: string, params: Record<string, unknown> = {}) => pipe.send(method, params, sessionId);
    await send('Page.enable');
    await send('Network.enable');
    await send('Network.setBlockedURLs', { urls: ['http://*', 'https://*', 'ftp://*', 'ws://*', 'wss://*'] });
    await send('Emulation.setScriptExecutionDisabled', { value: true });
    await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: pathToFileURL(options.htmlPath).href });
    // Poll from Node: disabling page scripts can suspend page timers and promise
    // callbacks during navigation. Inspector reads still work without enabling JS.
    for (;;) {
      const ready = await send('Runtime.evaluate', {
        expression: `location.href === ${JSON.stringify(pathToFileURL(options.htmlPath).href)} && document.readyState === 'complete' && document.fonts.status === 'loaded' && Array.from(document.images).every(image => image.complete)`,
        returnByValue: true,
      });
      if (ready['exceptionDetails'] !== undefined) {
        throw new IpynbError('internal', 'browser could not prepare the export document');
      }
      const result = ready['result'] as { value?: unknown } | undefined;
      if (result?.value === true) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    let result: Record<string, unknown>;
    if (options.format === 'pdf') {
      result = await send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true, displayHeaderFooter: false });
    } else {
      const metrics = await send('Page.getLayoutMetrics');
      const size = metrics['cssContentSize'] as { width?: number; height?: number } | undefined;
      const width = Math.max(1200, Math.ceil(size?.width ?? 1200));
      const height = Math.ceil(size?.height ?? 800);
      if (width > 16384 || height > 32767 || width * height > 64_000_000) {
        throw new IpynbError('invalid_arguments', 'notebook is too large for one PNG (maximum 16384 x 32767 and 64 million pixels); export HTML or PDF instead');
      }
      result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } });
    }
    const data = result['data'];
    if (typeof data !== 'string' || data === '') {
      throw new IpynbError('internal', 'browser returned an empty export');
    }
    return Buffer.from(data, 'base64');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    pipe.fail(new IpynbError('cancelled', 'export browser session closed'));
    try {
      await killBrowserTree(child, options.onWarning);
      await closed;
    } finally {
      process.removeListener('exit', onExit);
    }
  }
}
