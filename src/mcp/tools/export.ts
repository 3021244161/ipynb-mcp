import path from 'node:path';

import { IpynbError } from '../../core/errors.js';
import { renderExportDocument } from '../../core/export.js';
import { PathFence } from '../../fs/fence.js';
import { readNotebookFile } from '../../fs/notebook-file.js';
import {
  assertExportDestination, createExportWorkspace, defaultExportPath, findExportBrowser,
  publishExportFile, removeExportWorkspace, writeExportBytes,
} from '../../fs/export-file.js';
import { renderWithBrowser } from '../../render/browser.js';
import { optionalBoolean, optionalEnum, optionalString, rejectUnknownArguments, requireNonEmptyString, type ToolContext } from '../context.js';
import { runTool, type ToolOutcome } from './result.js';

export const notebookExportDescription =
  'Export saved notebook content and outputs to HTML, PDF or a full-page PNG without executing cells. PDF/PNG require local Chrome, Edge or Chromium. Paths stay inside root; overwrite defaults to false. Scripts, widgets and external resources are omitted.';

export async function handleNotebookExport(ctx: ToolContext, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolOutcome> {
  return runTool(async () => {
    rejectUnknownArguments(args, ['path', 'format', 'output_path', 'include_source', 'overwrite']);
    if (ctx.config.readOnly) {
      throw new IpynbError('read_only_mode', 'notebook_export is not allowed in read-only mode');
    }
    const input = requireNonEmptyString(args, 'path');
    requireNonEmptyString(args, 'format');
    const format = optionalEnum(args, 'format', ['html', 'pdf', 'png'] as const, 'html');
    const output = optionalString(args, 'output_path');
    const includeSource = optionalBoolean(args, 'include_source', true);
    const overwrite = optionalBoolean(args, 'overwrite', false);
    if (output !== undefined && output.trim() === '') {
      throw new IpynbError('invalid_arguments', 'output_path must be a non-empty string');
    }
    const checkCancelled = () => {
      if (signal?.aborted) {
        throw new IpynbError('cancelled', 'notebook export was cancelled');
      }
    };
    checkCancelled();
    // Explicit export never widens its write boundary through allow-outside-root.
    const fence = new PathFence(ctx.fence.root, false, ctx.platform);
    const absolutePath = fence.assertInside(input);
    const notebook = await readNotebookFile(absolutePath, ctx.hasher);
    const outputPath = fence.assertInside(output ?? defaultExportPath(absolutePath, format));
    await assertExportDestination(fence, absolutePath, outputPath, format, overwrite, ctx.platform);
    const executable = format === 'html' ? undefined : findExportBrowser(ctx.platform);
    const document = renderExportDocument(notebook, path.basename(absolutePath), includeSource);
    checkCancelled();
    const workspace = await createExportWorkspace(fence, outputPath);
    try {
      const htmlPath = path.join(workspace, 'notebook.html');
      await writeExportBytes(htmlPath, document.html);
      const bytes = executable === undefined ? Buffer.from(document.html, 'utf8') : await renderWithBrowser({
        executable, htmlPath, profilePath: path.join(workspace, 'profile'), format: format as 'pdf' | 'png', signal,
        onWarning: (message) => ctx.logger.warn(message),
      });
      checkCancelled();
      const temporaryPath = path.join(workspace, `result.${format}`);
      await writeExportBytes(temporaryPath, bytes);
      await assertExportDestination(fence, absolutePath, outputPath, format, overwrite, ctx.platform);
      checkCancelled();
      await publishExportFile(temporaryPath, outputPath, overwrite);
      return { payload: {
        path: absolutePath, format, output_path: outputPath, bytes: bytes.byteLength,
        cell_count: notebook.cells.length, include_source: includeSource, content_hash: notebook.contentHash,
        warnings: document.warnings.map((warning) => ({ code: warning.code, message: warning.message })),
      } };
    } finally {
      try {
        await removeExportWorkspace(workspace, fence);
      } catch (cause) {
        ctx.logger.warn(`could not remove export workspace: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
  }, ctx.logger);
}
