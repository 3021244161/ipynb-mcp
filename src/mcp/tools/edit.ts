// notebook_edit tool (SPEC §4.5): fence -> read -> apply ops on the model ->
// markdown gate -> backup -> atomic write. Failing ops never touch the file.

import path from 'node:path';

import { applyEditOps, type MarkdownIssue } from '../../core/edit.js';
import { IpynbError, type JsonValue, type Warning } from '../../core/errors.js';
import { checkMarkdown } from '../../core/markdown.js';
import { markdownTargetExists } from '../../fs/markdown-targets.js';
import { readNotebookFile, writeNotebookFile } from '../../fs/notebook-file.js';
import {
  optionalBoolean,
  optionalString,
  rejectUnknownArguments,
  requireNonEmptyString,
  requireOpsArray,
  type ToolContext,
} from '../context.js';
import { runTool, type ToolOutcome } from './result.js';

/**
 * Shared abort-cause check. `run.ts` used to carry a near-identical copy whose
 * only difference was a `signal.aborted` pre-check — two implementations of one
 * rule is a drift surface (review v3 QUAL-2).
 */
export function isAbortCause(cause: unknown, signal: AbortSignal | undefined): boolean {
  if (signal === undefined || !signal.aborted) {
    return false;
  }
  return (
    cause === signal.reason ||
    (cause instanceof Error && (cause.name === 'AbortError' || cause.message === 'aborted'))
  );
}

export const EDIT_ARGUMENTS = [
  'path',
  'ops',
  'expected_content_hash',
  'dry_run',
  'create_backup',
] as const;

export const notebookEditDescription =
  'Edit notebook cells. Every source change requires a compare-and-swap anchor (expected_source_hash or expected_text); a mismatch fails the whole request without writing.';

export async function handleNotebookEdit(
  ctx: ToolContext,
  args: Record<string, unknown>,
  options?: { signal?: AbortSignal },
): Promise<ToolOutcome> {
  return runTool(async () => {
    rejectUnknownArguments(args, EDIT_ARGUMENTS);
    const inputPath = requireNonEmptyString(args, 'path');
    const ops = requireOpsArray(args, 'ops');
    const expectedContentHash = optionalString(args, 'expected_content_hash');
    const dryRun = optionalBoolean(args, 'dry_run', false);
    const createBackup = optionalBoolean(args, 'create_backup', true);

    const absolutePath = ctx.fence.assertInside(inputPath);
    const notebook = await readNotebookFile(absolutePath, ctx.hasher);
    if (expectedContentHash !== undefined && expectedContentHash !== notebook.contentHash) {
      throw new IpynbError('file_changed', 'notebook changed since it was read', {
        expected: expectedContentHash,
        actual: notebook.contentHash,
      });
    }

    // The existsSync injection lives on the fs side (B1); core/markdown
    // resolves relative targets against the notebook's directory itself.
    const notebookDirForMarkdown = path.dirname(absolutePath);
    const checkMarkdownFn = (source: string): MarkdownIssue[] =>
      checkMarkdown(source, notebookDirForMarkdown, markdownTargetExists);

    const editResult = applyEditOps(notebook, ops, {
      hasher: ctx.hasher,
      nbformatMinor: notebook.doc.nbformat_minor,
      checkMarkdown: checkMarkdownFn,
    });

    const contentHashBefore = notebook.contentHash;
    let backupPath: string | null = null;
    let contentHashAfter = contentHashBefore;
    if (options?.signal?.aborted) {
      throw new IpynbError('cancelled', 'edit aborted by the client before writing', {});
    }
    if (!dryRun) {
      let writeResult;
      try {
        writeResult = await writeNotebookFile(notebook, absolutePath, {
          hasher: ctx.hasher,
          backupKeep: ctx.config.backupKeep,
          createBackup,
          expectedContentHash,
          signal: options?.signal,
          platform: ctx.platform,
          // Cleanup/diagnostics go through the logger, not raw stderr (C6g).
          onCleanupError: (message) => ctx.logger.warn(message),
        });
      } catch (cause) {
        if (isAbortCause(cause, options?.signal)) {
          throw new IpynbError('cancelled', 'edit aborted by the client during the write', {});
        }
        throw cause;
      }
      backupPath = writeResult.backupPath;
      contentHashAfter = writeResult.contentHashAfter;
      ctx.registry.bumpGeneration(absolutePath);
    }

    const payload: Record<string, unknown> = {
      path: absolutePath,
      dry_run: dryRun,
      applied: editResult.applied,
      failed_op_index: null,
      backup_path: backupPath,
      content_hash_before: contentHashBefore,
      content_hash_after: contentHashAfter,
      changed_cells: editResult.changedCells.map((cell) => ({
        cell_index: cell.cell_index,
        cell_id: cell.cell_id,
        new_line_count: cell.new_line_count,
        new_source_hash: cell.new_source_hash,
        outputs_cleared: cell.outputs_cleared,
      })),
      markdown_issues: editResult.markdownIssues,
      warnings: editResult.warnings.map((warning: Warning) => ({ code: warning.code, message: warning.message })),
    };
    return { payload: payload as JsonValue };
  });
}
