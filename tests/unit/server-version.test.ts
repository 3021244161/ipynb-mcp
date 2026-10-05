// [DEP-2] the reported version is the manifest's version, not a literal.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createServer } from '../../src/server.js';
import { hasher } from '../../src/hash.js';
import { KernelRegistry } from '../../src/kernel/registry.js';
import { RunStore } from '../../src/mcp/run-store.js';
import { PathFence } from '../../src/fs/fence.js';
import { createLogger } from '../../src/log.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('[DEP-2] the server version comes from package.json', () => {
  it('reports the manifest version', () => {
    const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string };
    const workspace = REPO_ROOT;
    const server = createServer({
      config: {
        root: workspace,
        allowOutsideRoot: false,
        readOnly: false,
        images: 'auto',
        python: null,
        kernelIdleSeconds: 3600,
        execTimeoutSeconds: 300,
        backgroundThresholdSeconds: 30,
        backupKeep: 10,
        artifactDir: path.join(workspace, 'artifacts'),
        inlineTextChars: 20000,
        previewLines: 12,
        maxImagesPerCall: 20,
        maxImageBytes: 20971520,
        maxResponseBytes: 8_388_608,
        logLevel: 'error',
      },
      fence: new PathFence(workspace, false, process.platform),
      registry: new KernelRegistry({ idleSeconds: 3600, logger: createLogger('error') }),
      runStore: new RunStore(),
      hasher,
      logger: createLogger('error'),
      realpath: (target) => target,
      platform: process.platform,
    });
    // The SDK keeps the client-facing identity on the underlying Server.
    const identity = (server.server as unknown as { _serverInfo?: { version?: string; name?: string } })._serverInfo;
    expect(identity?.version).toBe(manifest.version);
    expect(identity?.name).toBe('ipynb-mcp');
  });
});
