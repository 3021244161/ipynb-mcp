// MCP server assembly (SPEC §4.2, §4.6): six tools, single-text-block
// results (D24), progress notifications when the client sends a
// progressToken, IpynbError -> isError mapping, read-only guards (D18).

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

export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: 'ipynb-mcp', version: '0.1.0' });

  const wrap = (action: (args: Record<string, unknown>, extra: Extra) => Promise<ToolOutcome>) => {
    return async (rawArgs: Record<string, unknown>, extra: Extra): Promise<CallToolResult> => {
      // runTool is idempotent (catch -> toolFailure); wrapping the action here
      // keeps pre-handler throws (read_only_mode guard) inside the structured
      // isError result instead of surfacing as protocol errors (review A19).
      const outcome = await runTool(() => action(rawArgs, extra));
      return toCallToolResult(outcome);
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
      inputSchema: {
        path: z.string().describe('Notebook path (absolute, or relative to the server root)'),
        cell_indexes: z
          .array(z.number().int())
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
      },
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
      inputSchema: {
        path: z.string().describe('Notebook path'),
        ops: z
          .array(z.record(z.unknown()))
          .describe('1..32 edit ops (replace_lines, insert_lines, replace_source, insert_cell, delete_cell, move_cell, set_cell_type, clear_outputs)'),
        expected_content_hash: z.string().optional().describe('Optional optimistic-lock hash'),
        dry_run: z.boolean().optional().describe('Compute everything but do not write. Default false'),
        create_backup: z.boolean().optional().describe('Default true'),
      },
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
      inputSchema: {
        path: z.string().describe('Notebook path'),
        cell_selector: z
          .string()
          .optional()
          .describe("Which code cells to run: 'all' (default), '3', '0-4', or a comma list like '0-4,7,9'. This is a string selector — do not pass an array."),
        mode: z.string().optional().describe("Execution mode: 'auto' (default) | 'resume' | 'replay' | 'full'"),
        timeout_seconds: z.number().optional().describe('Per-cell timeout in seconds (1..86400; default from server config)'),
        write_outputs: z.boolean().optional().describe('Write fresh outputs back to the .ipynb. Default true'),
        clear_outputs_before: z.boolean().optional().describe("Clear target cells' outputs before running. Default true"),
        expected_content_hash: z.string().optional().describe('Optional optimistic-lock hash'),
        create_backup: z.boolean().optional().describe('Default true'),
      },
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
      inputSchema: {
        run_id: z.string().describe('Run id returned by notebook_run'),
      },
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
      inputSchema: {
        run_id: z.string().describe('Run id returned by notebook_run'),
      },
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
      inputSchema: {
        action: z.string().describe("One of 'status' | 'start' | 'shutdown' | 'restart'"),
        path: z.string().optional().describe('Notebook path; required for start/shutdown/restart, ignored for status'),
      },
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
