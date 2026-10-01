// notebook_read tool (SPEC §4.3).

import { IpynbError } from '../../core/errors.js';
import { readNotebookFile } from '../../fs/notebook-file.js';
import { renderReadResult } from '../render/read.js';
import {
  optionalEnum,
  optionalIndexArray,
  optionalString,
  requireNonEmptyString,
  type ToolContext,
} from '../context.js';
import { runTool, type ToolOutcome } from './result.js';

export const notebookReadDescription =
  "Read a Jupyter notebook: cell index, type, source and existing outputs. Set include_outputs='full' to get a cell's outputs including images.";

export async function handleNotebookRead(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  return runTool(async () => {
    const inputPath = requireNonEmptyString(args, 'path');
    const cellIndexes = optionalIndexArray(args, 'cell_indexes');
    const includeSource = optionalEnum(args, 'include_source', ['none', 'preview', 'full'] as const, 'preview');
    const includeOutputs = optionalEnum(args, 'include_outputs', ['none', 'summary', 'full'] as const, 'summary');
    const expectedContentHash = optionalString(args, 'expected_content_hash');

    const absolutePath = ctx.fence.assertInside(inputPath);
    const notebook = await readNotebookFile(absolutePath, ctx.hasher);
    if (expectedContentHash !== undefined && expectedContentHash !== notebook.contentHash) {
      throw new IpynbError('file_changed', 'notebook changed since it was read', {
        expected: expectedContentHash,
        actual: notebook.contentHash,
      });
    }
    if (cellIndexes !== undefined) {
      for (const index of cellIndexes) {
        if (index >= notebook.cells.length) {
          throw new IpynbError('range_out_of_bounds', `cell_index ${index} out of range 0..${notebook.cells.length - 1}`, {
            cell_index: index,
            cell_count: notebook.cells.length,
          });
        }
      }
    }

    const rendered = await renderReadResult({
      notebook,
      path: absolutePath,
      cellIndexes,
      includeSource,
      includeOutputs,
      previewLines: ctx.config.previewLines,
      imagesPolicy: ctx.config.images,
      maxImagesPerCall: ctx.config.maxImagesPerCall,
      maxImageBytes: ctx.config.maxImageBytes,
      inlineTextChars: ctx.config.inlineTextChars,
      artifactDir: ctx.config.artifactDir,
      platform: ctx.platform,
      realpath: ctx.realpath,
      hasher: ctx.hasher,
    });
    return { payload: rendered.payload as import('../../core/errors.js').JsonValue, imageBlocks: rendered.imageBlocks };
  });
}
