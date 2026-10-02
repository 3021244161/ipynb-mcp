#!/usr/bin/env node
// Entry point (SPEC §3.2, §5.1): parse args, validate startup state
// (exit code 2 on failure), wire the stdio transport, guarantee
// shutdown_all on stdin close / SIGINT / SIGTERM (no orphan kernels, R19).

import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import process from 'node:process';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { USAGE, parseConfig, validateStartupFiles } from './config.js';
import { createLogger } from './log.js';
import { KernelRegistry } from './kernel/registry.js';
import { RunStore } from './mcp/run-store.js';
import type { ToolContext } from './mcp/context.js';
import { PathFence } from './fs/fence.js';
import { hasher } from './hash.js';
import { createServer } from './server.js';

async function main(): Promise<number> {
  const parseResult = parseConfig(process.argv.slice(2), process.env);
  if (parseResult.helpRequested) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (parseResult.errors.length > 0 || parseResult.config === undefined) {
    for (const error of parseResult.errors) {
      process.stderr.write(`error: ${error}\n`);
    }
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const config = parseResult.config;

  const logger = createLogger(config.logLevel);
  const startupErrors = validateStartupFiles(
    config,
    {
      existsSync: (target) => {
        try {
          realpathSync(target);
          return true;
        } catch {
          return false;
        }
      },
      statSync: (target) => statSync(target),
      realpathSync: (target) => realpathSync(target),
      mkdirSync: (target, options) => mkdirSync(target, options),
      homedir: () => homedir(),
    },
    process.platform,
  );
  if (startupErrors.length > 0) {
    for (const error of startupErrors) {
      process.stderr.write(`error: ${error}\n`);
    }
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }

  const registry = new KernelRegistry({ idleSeconds: config.kernelIdleSeconds, logger });
  registry.start();
  const runStore = new RunStore();

  const ctx: ToolContext = {
    config,
    fence: new PathFence(config.root, config.allowOutsideRoot, process.platform),
    registry,
    runStore,
    hasher,
    logger,
    realpath: (target) => realpathSync(target),
    platform: process.platform,
  };

  const server = createServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info(`ipynb-mcp serving root ${config.root}`);

  let shuttingDown = false;
  const shutdown = (reason: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info(`shutting down (${reason})`);
    void registry
      .shutdownAll()
      .then(() => server.close())
      .then(() => process.exit(0))
      .catch(() => process.exit(0));
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.stdin.on('close', () => shutdown('stdin closed'));

  // Last-resort hooks (review A23): an uncaught exception must not skip
  // shutdown_all — POSIX sidecars run as detached process groups and would
  // otherwise outlive this process (R19: no orphan kernels).
  const fatal = (reason: string, cause: unknown): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.error(`fatal: ${reason}: ${String(cause)}`);
    void registry
      .shutdownAll()
      .catch(() => undefined)
      .finally(() => process.exit(2));
  };
  process.on('uncaughtException', (cause) => fatal('uncaughtException', cause));
  // An unhandled rejection used to run the same fatal path, which made any
  // stray rejection a mid-session server exit (review R2: the idle-reclaim
  // timer was a reachable trigger). SPEC §5.1's exit-code-2 rule is about
  // STARTUP failures; a runtime rejection that the process survived is a
  // diagnosable event, not a reason to drop the client mid-conversation.
  process.on('unhandledRejection', (cause) => {
    logger.error(`unhandled rejection (continuing to serve): ${String(cause)}`);
  });

  return 0;
}

main()
  .then((code) => {
    if (code !== 0) {
      process.exit(code);
    }
  })
  .catch((cause: unknown) => {
    process.stderr.write(`fatal: ${String(cause)}\n`);
    process.exit(2);
  });
