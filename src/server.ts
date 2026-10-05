// MCP server assembly (SPEC §4.2, §4.6): six tools, single-text-block
// results (D24), progress notifications when the client sends a
// progressToken, IpynbError -> isError mapping, read-only guards (D18).

import { createRequire } from 'node:module';

import type { CallToolResult, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { z } from 'zod';

import { IpynbError } from './core/errors.js';
import type { ToolContext } from './mcp/context.js';
import { runTool, toCallToolResult, type ToolOutcome } from './mcp/tools/result.js';
import { handleNotebookRead, notebookReadDescription } from './mcp/tools/read.js';
import { handleNotebookEdit, notebookEditDescription } from './mcp/tools/edit.js';
import { handleNotebookRun, notebookRunDescription, type RunToolHooks } from './mcp/tools/run.js';
import {
  handleRunCancel,
  handleRunStatus,
  notebookRunCancelDescription,
  notebookRunStatusDescription,
} from './mcp/tools/run-status.js';
import { handleNotebookKernel, notebookKernelDescription } from './mcp/tools/kernel.js';

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * The SDK validates the declared shape with a NON-strict zod object, so an
 * unknown key was silently stripped before the handler ran — the advertised
 * JSON Schema even said `additionalProperties: false` while the runtime dropped
 * the key instead of rejecting it (measured, review v3 SEC-1). A caller that
 * misspelled `cell_selector` therefore read the WHOLE notebook with no error.
 *
 * `.passthrough()` keeps unknown keys alive so the tool layer can reject them
 * with `invalid_arguments`, which is what SPEC §4.1.12 asks for. It also keeps
 * the rejection REACHABLE: with a strict schema the SDK refuses first, and the
 * tool-layer whitelist becomes dead code that no test can prove is wired
 * (review v4 NEW-1 measured exactly that). The advertised schema still says
 * `additionalProperties: false`, because the passthrough schema's inferred JSON
 * Schema has always reported that — a literal reading of the schema and the
 * runtime behaviour now agree on the outcome (rejected), which is what the
 * caller observes.
 */
function strict<T extends Record<string, z.ZodTypeAny>>(fields: T) {
  return z.object(fields).passthrough();
}

/**
 * The version this server reports, read from the package manifest.
 *
 * A literal here meant a release could ship a server announcing a version that
 * was not the one in the tarball, with no test able to notice (review v6 DEP-2).
 * `createRequire` reads it from an ESM module without a build step or a JSON
 * import assertion.
 */
function packageVersion(): string {
  try {
    const manifest = createRequire(import.meta.url)('../package.json') as { version?: unknown };
    return typeof manifest.version === 'string' && manifest.version !== '' ? manifest.version : '0.0.0';
  } catch {
    // A packaged layout without the manifest must not break startup; the version
    // string is informational.
    return '0.0.0';
  }
}

export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: 'ipynb-mcp-server', version: packageVersion() });

  const wrap = (action: (args: Record<string, unknown>, extra: Extra) => Promise<ToolOutcome>) => {
    return async (rawArgs: Record<string, unknown>, extra: Extra): Promise<CallToolResult> => {
      // runTool is idempotent (catch -> toolFailure); wrapping the action here
      // keeps pre-handler throws (read_only_mode guard) inside the structured
      // isError result instead of surfacing as protocol errors (review A19).
      // The logger receives unexpected stacks, which stay out of the
      // model-visible detail (review v3 SEC-2).
      const outcome = await runTool(() => action(rawArgs, extra), ctx.logger);
      // The response budget is applied at the ONE exit every tool shares, so no tool can forget it. It
      // is the server's promise about what the transport can carry, not a per-tool policy, which is why
      // it lives here rather than in each handler (review v13 V13-1).
      return toCallToolResult(outcome, { maxResponseBytes: ctx.config.maxResponseBytes });
    };
  };

  const progressHooks = (extra: Extra): RunToolHooks => {
    const token = extra._meta?.progressToken;
    if (token === undefined || token === null) {
      return {};
    }
    return {
      onProgress: (event) => {
        void extra
          .sendNotification({
            method: 'notifications/progress',
            params: {
              progressToken: token,
              progress: event.progress,
              total: event.total,
              message: event.phase,
            },
          })
          .catch((cause: unknown) => {
            // Notification failures must never fail the run, but a stuck
            // client progress bar should be diagnosable (R7, review A24).
            ctx.logger.warn(`progress notification failed: ${String(cause)}`);
          });
      },
      signal: extra.signal,
    };
  };

  server.registerTool(
    'notebook_read',
    {
      description: notebookReadDescription,
      // The tool layer enforces the argument whitelist (see the helper above);
      // the SDK side deliberately passes unknown keys through.
      inputSchema: strict({
        path: z.string().describe('Notebook path (absolute, or relative to the server root)'),
        cell_indexes: z
          .array(z.number().int())
          // NO `.max()` here on purpose: the SDK turns a zod violation into a
          // protocol error, while SPEC §4.1.12 wants a VALUE-level rejection as
          // `invalid_arguments` (same split as `ops`, which is also bounded in
          // the tool layer). The bound lives in handleNotebookRead.
          .optional()
          .describe("0-based cell indexes to read; omit for all cells. This is an integer array — do not pass a range string."),
        include_source: z
          .string()
          .optional()
          .describe("Source detail: 'none' | 'preview' (default) | 'full'"),
        include_outputs: z
          .string()
          .optional()
          .describe("Output detail: 'none' | 'summary' (default) | 'full'"),
        expected_content_hash: z.string().optional().describe('Optional optimistic-lock hash'),
      }),
    },
    wrap((args, extra) => {
      assertWritableAllowed(ctx, 'notebook_read', false);
      void extra;
      return handleNotebookRead(ctx, args);
    }),
  );

  server.registerTool(
    'notebook_edit',
    {
      description: notebookEditDescription,
      // The tool layer enforces the argument whitelist (see the helper above);
      // the SDK side deliberately passes unknown keys through.
      inputSchema: strict({
        path: z.string().describe('Notebook path'),
        ops: z
          .array(z.record(z.unknown()))
          .describe('1..32 edit ops (replace_lines, insert_lines, replace_source, insert_cell, delete_cell, move_cell, set_cell_type, clear_outputs)'),
        expected_content_hash: z.string().optional().describe('Optional optimistic-lock hash'),
        dry_run: z.boolean().optional().describe('Compute everything but do not write. Default false'),
        create_backup: z.boolean().optional().describe('Default true'),
      }),
    },
    wrap((args, extra) => {
      assertWritableAllowed(ctx, 'notebook_edit', true);
      return handleNotebookEdit(ctx, args, { signal: extra.signal });
    }),
  );

  server.registerTool(
    'notebook_run',
    {
      description: notebookRunDescription,
      // The tool layer enforces the argument whitelist (see the helper above);
      // the SDK side deliberately passes unknown keys through.
      inputSchema: strict({
        path: z.string().describe('Notebook path'),
        cell_selector: z
          .string()
          .optional()
          .describe("Which code cells to run: 'all' (default), '3', '0-4', or a comma list like '0-4,7,9'. This is a string selector — do not pass an array."),
        // Declaring the accepted set documents it to the model instead of
        // leaving it to prose, and `.int()` is not decoration: the tool layer
        // validates 1..86400, which a fractional value like 0.5 passed while
        // being meaningless as a timeout (review v4 NEW-2).
        // A STRING, not `z.enum`: a schema enum makes the SDK answer an invalid
        // value with a -32602 protocol error before the handler runs, while
        // SPEC §4.1.12 / U27 require `invalid_arguments` from the tool layer. The
        // accepted set is stated here for the model and enforced in the handler,
        // so validation lives in exactly one place (review v4 NEW-2, resolved in
        // v7 after the review showed the two layers disagreeing).
        mode: z
          .string()
          .optional()
          .describe("Execution mode: 'auto' (default) | 'resume' | 'replay' | 'full'"),
        timeout_seconds: z.number().int().optional().describe('Per-cell timeout in seconds (1..86400; default from server config)'),
        write_outputs: z.boolean().optional().describe('Write fresh outputs back to the .ipynb. Default true'),
        clear_outputs_before: z.boolean().optional().describe("Clear target cells' outputs before running. Default true"),
        expected_content_hash: z.string().optional().describe('Optional optimistic-lock hash'),
        create_backup: z.boolean().optional().describe('Default true'),
      }),
    },
    wrap((args, extra) => {
      assertWritableAllowed(ctx, 'notebook_run', true);
      return handleNotebookRun(ctx, args, progressHooks(extra));
    }),
  );

  server.registerTool(
    'notebook_run_status',
    {
      description: notebookRunStatusDescription,
      // The tool layer enforces the argument whitelist (see the helper above);
      // the SDK side deliberately passes unknown keys through.
      inputSchema: strict({
        run_id: z.string().describe('Run id returned by notebook_run'),
      }),
    },
    wrap((args) => {
      assertWritableAllowed(ctx, 'notebook_run_status', true);
      return handleRunStatus(ctx, args);
    }),
  );

  server.registerTool(
    'notebook_run_cancel',
    {
      description: notebookRunCancelDescription,
      // The tool layer enforces the argument whitelist (see the helper above);
      // the SDK side deliberately passes unknown keys through.
      inputSchema: strict({
        run_id: z.string().describe('Run id returned by notebook_run'),
      }),
    },
    wrap((args) => {
      assertWritableAllowed(ctx, 'notebook_run_cancel', true);
      return handleRunCancel(ctx, args);
    }),
  );

  server.registerTool(
    'notebook_kernel',
    {
      description: notebookKernelDescription,
      // The tool layer enforces the argument whitelist (see the helper above);
      // the SDK side deliberately passes unknown keys through.
      inputSchema: strict({
        action: z.string().describe("One of 'status' | 'start' | 'shutdown' | 'restart'"),
        path: z.string().optional().describe('Notebook path; required for start/shutdown/restart, ignored for status'),
      }),
    },
    wrap((args) => {
      // read-only mode only allows action 'status'; enforced in the handler.
      return handleNotebookKernel(ctx, args);
    }),
  );

  return server;
}

function assertWritableAllowed(ctx: ToolContext, tool: string, writable: boolean): void {
  if (ctx.config.readOnly && writable) {
    throw new IpynbError('read_only_mode', `tool '${tool}' is not allowed in read-only mode`, { tool });
  }
}
