// notebook_kernel tool (SPEC §4.9): status across notebooks, start/shutdown/
// restart per notebook. Shutting down or restarting a kernel that carries a
// running run fails that run with kernel_died immediately (SPEC §4.8).

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';

import { IpynbError, type JsonValue } from '../../core/errors.js';
import { readNotebookFile } from '../../fs/notebook-file.js';
import { resolveInterpreter } from '../../kernel/interpreter.js';
import type { KernelSessionInfo } from '../../kernel/registry.js';
import { requireNonEmptyString, type ToolContext } from '../context.js';
import { runTool, type ToolOutcome } from './result.js';

export const notebookKernelDescription =
  'Inspect or manage the kernels held for notebooks: status, start, shutdown, restart.';

export async function handleNotebookKernel(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  return runTool(async () => {
    const action = requireNonEmptyString(args, 'action');
    if (action !== 'status' && action !== 'start' && action !== 'shutdown' && action !== 'restart') {
      throw new IpynbError('invalid_arguments', `invalid argument 'action': must be one of status|start|shutdown|restart`, {
        field: 'action',
      });
    }
    if (ctx.config.readOnly && action !== 'status') {
      throw new IpynbError('read_only_mode', `action '${action}' is not allowed in read-only mode`, {
        action,
      });
    }

    if (action === 'status') {
      const payload: Record<string, unknown> = {
        action,
        kernels: ctx.registry.listKernels().map(sessionInfo),
        warnings: [],
      };
      return { payload: payload as JsonValue };
    }

    const inputPath = requireNonEmptyString(args, 'path');
    const absolutePath = ctx.fence.assertInside(inputPath);

    if (action === 'shutdown' || action === 'restart') {
      // Fail every running background run hosted on this notebook's kernel
      // immediately (SPEC §4.8): abort now, interrupt best-effort; completed
      // cells still get written back by the background task.
      for (const runId of ctx.runStore.listRunningRunIds()) {
        const handle = ctx.runStore.get(runId);
        if (handle !== null && handle.notebookPath === absolutePath) {
          handle.abortReason = 'kernel_died';
          handle.abortController.abort();
          // SPEC §4.8 rule 1: the run lands in its terminal state IMMEDIATELY
          // (before the in-flight cell finishes); the background task then
          // writes back completed cells under the same terminal state.
          if (handle.state === 'running') {
            handle.state = 'failed';
            handle.error = { code: 'kernel_died', message: 'kernel was shut down or restarted while the run was in flight' };
          }
          void ctx.registry.interrupt(absolutePath).catch(() => {
            // kernel already gone
          });
        }
      }
    }

    if (action === 'start') {
      const notebook = await readNotebookFile(absolutePath, ctx.hasher);
      const metadata = notebook.doc.metadata as Record<string, unknown>;
      const kernelspec = metadata['kernelspec'];
      const kernelSpecName =
        typeof kernelspec === 'object' && kernelspec !== null
          ? String((kernelspec as Record<string, unknown>)['name'] ?? '') || null
          : null;
      const languageInfo = metadata['language_info'];
      const languageInfoName =
        typeof languageInfo === 'object' && languageInfo !== null
          ? String((languageInfo as Record<string, unknown>)['name'] ?? '') || null
          : null;
      const resolution = await resolveInterpreter(
        {
          explicitPython: ctx.config.python,
          notebookPath: absolutePath,
          kernelSpecName,
          languageInfoName,
        },
        {
          platform: ctx.platform,
          env: process.env,
          existsSync: (target) => existsSync(target),
          readFile: async (target) => readFile(target, 'utf8'),
          execFile: (command, args, timeoutMs) =>
            new Promise((resolve) => {
              execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (error) => {
                if (error === null) {
                  resolve('ok');
                } else {
                  resolve((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not-found' : 'failed');
                }
              });
            }),
          resolveExecutable: (command, timeoutMs) =>
            new Promise((resolve) => {
              execFile(command, ['-c', 'import sys; print(sys.executable)'], { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
                if (error !== null) {
                  resolve(null);
                  return;
                }
                const resolved = stdout.trim().split('\n')[0] ?? '';
                resolve(resolved === '' ? null : resolved);
              });
            }),
          homedir: () => homedir(),
        },
      );
      const session = await ctx.registry.getOrCreate({
        notebookPath: absolutePath,
        interpreterPath: resolution.interpreterPath,
        kernelSpecName: resolution.kernelSpecName,
        language: resolution.language,
      });
      const payload: Record<string, unknown> = {
        action,
        kernels: [sessionInfo(session)],
        warnings: resolution.warnings,
      };
      return { payload: payload as JsonValue };
    }

    if (action === 'shutdown') {
      await ctx.registry.shutdown(absolutePath);
      const payload: Record<string, unknown> = { action, kernels: [], warnings: [] };
      return { payload: payload as JsonValue };
    }

    const session = await ctx.registry.restart(absolutePath);
    const payload: Record<string, unknown> = {
      action: 'restart',
      kernels: session === null ? [] : [sessionInfo(session)],
      warnings: [],
    };
    return { payload: payload as JsonValue };
  });
}

function sessionInfo(session: KernelSessionInfo): Record<string, unknown> {
  return {
    kernel_id: session.kernelId,
    notebook_path: session.notebookPath,
    interpreter_path: session.interpreterPath,
    kernel_spec_name: session.kernelSpecName,
    language: session.language,
    alive: session.alive,
    started_at: session.startedAt,
    last_used_at: session.lastUsedAt,
    execution_count: session.executionCount,
    pid: session.pid,
  };
}
