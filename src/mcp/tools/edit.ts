// notebook_edit tool (SPEC §4.5): fence -> read -> apply ops on the model ->
// markdown gate -> backup -> atomic write. Failing ops never touch the file.

import path from 'node:path';

import { applyEditOps, type MarkdownIssue } from '../../core/edit.js';
import {
  IpynbError,
  PREEXISTING_CONTENT_WARNING,
  createWarning,
  isAbortCause,
  type JsonValue,
  type Warning,
} from '../../core/errors.js';
import { checkMarkdown } from '../../core/markdown.js';
import { markdownTargetExists } from '../../fs/markdown-targets.js';
import { serializeNotebook, type NotebookFile } from '../../core/parse.js';
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

// Re-exported for callers that already import this module; the rule itself
// lives in core/errors.ts so `run.ts` and this file cannot drift apart
// (review v3 QUAL-2, closed in the v6 round).
export { isAbortCause };

export const EDIT_ARGUMENTS = [
  'path',
  'ops',
  'expected_content_hash',
  'dry_run',
  'create_backup',
] as const;

export const notebookEditDescription =
  'Edit notebook cells. Every source change requires a compare-and-swap anchor (expected_source_hash or expected_text); a mismatch fails the whole request without writing.';

/**
 * Adapts the `beforeWrite` test hook onto the writer's serializer seam: the hook
 * must fire at a point where "the read succeeded, the write has not happened" is
 * already decided, and serialization is exactly that point.
 */
function wrapSerializer(hook: () => void): (notebook: NotebookFile) => string {
  return (notebook) => {
    hook();
    return serializeNotebook(notebook);
  };
}

export async function handleNotebookEdit(
  ctx: ToolContext,
  args: Record<string, unknown>,
  options?: {
    signal?: AbortSignal;
    /**
     * Runs after the read/hash check and after serialization, immediately before
     * the write lands (`fs/notebook-file.ts`). Test-only seam: a Windows
     * exclusive-handle case needs the lock to appear AFTER the read succeeded, so
     * that it exercises the write path rather than the read path — with a real
     * handle there is no other way to pin that moment (CI issue #1 problem 3).
     */
    beforeWrite?: () => void;
  },
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
    const structuralWarnings: string[] = [];
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
          ...(options?.beforeWrite === undefined ? {} : { serialize: wrapSerializer(options.beforeWrite) }),
          // The gate judges the cells THIS edit rewrote, so a pre-existing quirk
          // elsewhere in the user's file cannot make the notebook permanently
          // read-only, and a pure reorder is not treated as authorship of the
          // moved cell (review v5 GATE-1, v6 SCOPE-REFUSE-HINT).
          touchedCellIndexes: new Set(
            editResult.changedCells.filter((cell) => cell.content_changed).map((cell) => cell.cell_index),
          ),
          // The pre-edit document, so a refusal can say whether it is refusing
          // OUR output or content that was already there.
          originalDoc: structuredClone(notebook.doc),
          // Carried-forward content is reported to the caller as a warning (the
          // same channel notebook_run uses) AND to the log. A bare log line would
          // tell the operator while leaving the model — the actual consumer —
          // believing the file is clean.
          onStructuralWarning: (message) => {
            structuralWarnings.push(message);
            ctx.logger.warn(message);
          },
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
      warnings: [
        ...editResult.warnings.map((warning: Warning) => ({ code: warning.code, message: warning.message })),
        // `file_changed_externally` rather than an invented 12th code: §7's list is
        // closed, and this is the entry whose trigger matches what actually
        // happened — the preserved content came from outside this tool (review v6
        // WARN-CODE-1). The rule and the cell index are in the free-form message.
        ...structuralWarnings.map((message) => createWarning(PREEXISTING_CONTENT_WARNING, message)),
      ],
    };
    return { payload: payload as JsonValue };
  });
}
