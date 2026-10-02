// notebook_read tool (SPEC §4.3).

import { IpynbError } from '../../core/errors.js';
import { readNotebookFile } from '../../fs/notebook-file.js';
import { renderReadResult } from '../render/read.js';
import {
  MAX_INDEX_ARRAY_LENGTH,
  optionalEnum,
  optionalIndexArray,
  optionalString,
  rejectUnknownArguments,
  requireNonEmptyString,
  type ToolContext,
} from '../context.js';
import { runTool, type ToolOutcome } from './result.js';

export const notebookReadDescription =
  "Read a Jupyter notebook: cell index, type, source and existing outputs. Set include_outputs='full' to get a cell's outputs including images.";

const READ_ARGUMENTS = [
  'path',
  'cell_indexes',
  'include_source',
  'include_outputs',
  'expected_content_hash',
] as const;

export async function handleNotebookRead(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  return runTool(async () => {
    rejectUnknownArguments(args, READ_ARGUMENTS);
    const inputPath = requireNonEmptyString(args, 'path');
    const cellIndexes = dedupeIndexes(optionalIndexArray(args, 'cell_indexes'));
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

/**
 * SPEC §4.1.12 requires server-side length validation for array arguments (the
 * `ops` 1..32 rule is the existing precedent). `cell_indexes` had no cap and no
 * dedup, so repeating one index scaled the response size with the ARGUMENT
 * length: 20 000 repeats produced a 5.6 MB text block from a 5-cell notebook
 * (review v3 ROB-5). Dedup first, then apply the cap to what is actually
 * rendered.
 */
function dedupeIndexes(indexes: readonly number[] | undefined): number[] | undefined {
  if (indexes === undefined) {
    return undefined;
  }
  const unique = [...new Set(indexes)].sort((a, b) => a - b);
  if (unique.length > MAX_INDEX_ARRAY_LENGTH) {
    throw new IpynbError(
      'invalid_arguments',
      `too many cell_indexes: ${unique.length} (max ${MAX_INDEX_ARRAY_LENGTH})`,
      { field: 'cell_indexes', count: unique.length, max: MAX_INDEX_ARRAY_LENGTH },
    );
  }
  return unique;
}
