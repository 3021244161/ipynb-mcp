// notebook_read projection (SPEC §4.3): the model-facing JSON payload plus
// image blocks. Source previews and output summaries keep the default read
// cheap (no kernel, no artifacts); full outputs materialize images only when
// the image policy allows blocks to be returned.

import { createWarning, type Warning } from '../../core/errors.js';
import { mapRawOutputs, rawOutputsOfCell, collectOutputWarnings, type OutputItem } from '../../core/outputs.js';
import {
  cellSource,
  executionCountForDisplay,
  hasStableCellIds,
  readNotebookMetadata,
  type NotebookFile,
} from '../../core/parse.js';
import { applyImagePolicy, shouldReturnImages, type ImagesPolicy } from '../../fs/artifact.js';

const SUMMARY_PREVIEW_CHARS = 160;

export interface RenderReadResult {
  readonly payload: Record<string, unknown>;
  readonly imageBlocks: ReadonlyArray<{ data: string; media_type: 'image/png' | 'image/jpeg' }>;
}

export interface RenderReadInput {
  readonly notebook: NotebookFile;
  readonly path: string;
  readonly cellIndexes?: readonly number[];
  readonly includeSource: 'none' | 'preview' | 'full';
  readonly includeOutputs: 'none' | 'summary' | 'full';
  readonly previewLines: number;
  readonly imagesPolicy: ImagesPolicy;
  readonly maxImagesPerCall: number;
  readonly maxImageBytes: number;
  readonly inlineTextChars: number;
  readonly artifactDir: string;
  readonly platform: NodeJS.Platform;
  readonly realpath: (target: string) => string;
  readonly hasher: import('../../core/parse.js').Hasher;
}

export async function renderReadResult(input: RenderReadInput): Promise<RenderReadResult> {
  const warnings: Warning[] = [];
  const imageBlocks: Array<{ data: string; media_type: 'image/png' | 'image/jpeg' }> = [];

  const doc = input.notebook.doc;
  const { kernelName, languageName, languageVersion } = readNotebookMetadata(doc);

  const selectedIndexes =
    input.cellIndexes !== undefined ? [...input.cellIndexes].sort((a, b) => a - b) : input.notebook.cells.map((_, i) => i);
  // `cell_indexes` is deduped by the tool layer before it gets here (SPEC
  // §4.1.12 length validation + review v3 ROB-5), so this loop renders each
  // requested cell exactly once.

  // Running cursor so image_index stays unique across the whole call
  // (SPEC §4.3), not reset per cell (review A5).
  let imageCursor = 0;
  let limitWarned = false;
  const cellsPayload: Array<Record<string, unknown>> = [];
  for (const index of selectedIndexes) {
    const cell = input.notebook.cells[index];
    if (cell === undefined) {
      continue;
    }
    const source = cellSource(cell);
    const lines = source.split('\n');
    const sourcePreviewCount =
      input.includeSource === 'none' ? 0 : input.includeSource === 'preview' ? Math.min(lines.length, input.previewLines) : lines.length;
    const sourceTruncated = input.includeSource === 'preview' && lines.length > input.previewLines;

    const cellPayload: Record<string, unknown> = {
      cell_index: index,
      cell_id: cell.id ?? null,
      cell_type: cell.cell_type,
      // `executionCountForDisplay`, not the field itself: a count written as
      // `9007199254740993` is held as an exact-number marker internally, and handing the
      // marker to the model publishes a structure that exists nowhere (review v11 V11-6).
      execution_count: cell.cell_type === 'code' ? executionCountForDisplay(cell) : null,
      // WHEN `source` IS THE WHOLE THING, THE PREVIEW IS NOT EMITTED. `include_source='full'` used to
      // send every line twice — once as `source_preview` (all of them) and once as `source` — so the
      // response was about 2x the notebook's source, and a 5 MiB source produced a >10 MiB frame that
      // killed the client's connection (review v15 V15-1). An empty preview is not a loss of
      // information: `source` holds every line, and `source_line_count` states how many
      // (review v15 V15-1③).
      source_preview: input.includeSource === 'full' ? [] : lines.slice(0, sourcePreviewCount),
      source_line_count: lines.length,
      source_truncated: sourceTruncated,
      source: input.includeSource === 'full' ? source : null,
    };

    if (input.includeOutputs === 'none') {
      cellPayload['outputs_summary'] = [];
      cellPayload['outputs'] = null;
    } else if (cell.cell_type !== 'code') {
      cellPayload['outputs_summary'] = [];
      cellPayload['outputs'] = null;
    } else {
      // nbformat output shape lives in core (review v3 ARCH-1 / AGENTS §4).
      const typedRawOutputs = rawOutputsOfCell(cell);
      const mapped = mapRawOutputs(typedRawOutputs, {
        inlineTextChars: input.inlineTextChars,
        maxImageBytes: input.maxImageBytes,
        hasher: input.hasher,
        // So an image failure can name the cell, which is what makes the per-cell warnings
        // distinguishable instead of three identical lines (review v11 V11-10).
        cellIndex: index,
      });
      const returnImages = shouldReturnImages(input.imagesPolicy, input.includeOutputs === 'full');
      // applyImagePolicy treats maxImages as an ABSOLUTE call-wide cap and
      // indexStart as this batch's offset into the call's image blocks. Passing
      // the remaining budget against an absolute cursor compared two different
      // coordinate systems: cell 1 using 9 of 20 left budget 11, so cell 2's
      // images were dropped from index 11 on and image_limit was reported for
      // images that fit (review W4).
      const policyResult = await applyImagePolicy(
        mapped.items,
        mapped.extractedImages,
        { returnImages, maxImages: input.maxImagesPerCall, indexStart: imageCursor },
        {
          artifactRoot: input.artifactDir,
          notebookAbsPath: input.path,
          cellIndex: index,
          platform: input.platform,
          realpath: input.realpath,
        },
      );
      for (const warning of policyResult.warnings) {
        if (warning.code === 'image_limit' && limitWarned) {
          continue;
        }
        if (warning.code === 'image_limit') {
          limitWarned = true;
        }
        warnings.push(warning);
      }
      imageCursor += policyResult.materialized.length;
      if (returnImages) {
        for (const materialized of policyResult.materialized) {
          const image = mapped.items[materialized.outputIndex];
          if (image !== undefined && image.kind === 'image') {
            // The payload comes from the materialization decision, NOT from the
            // document: it is the base64 of the bytes that were just written, so it
            // is valid by construction. Reading the raw value back here is how a
            // `data:` URL reached the SDK and turned the whole call into `-32602`
            // (review v9 V9-1).
            imageBlocks.push({ data: materialized.base64, media_type: image.media_type });
          }
        }
      }

      cellPayload['outputs_summary'] = input.includeOutputs === 'summary' ? summarizeOutputs(mapped.items) : null;
      cellPayload['outputs'] = input.includeOutputs === 'full' ? mapped.items : null;
      if (mapped.items.length > 0) {
        // Per-output problems are lifted into the CALL-level `warnings[]`, which is the
        // field a client reads.
        //
        // This used to run only for `full`, and that was a silent-rounding bug on the
        // DEFAULT path (review v11 V11-5): `mapRawOutputs` had already projected
        // `9007199254740993` to `…992` and `1e400` to `null`, and `summary` — the default,
        // the token-cheapest, the one SPEC §4.3 recommends — showed those values in its
        // preview with `warnings: []`. The model reads `…992`, the file says `…993`, and
        // nothing anywhere says so: SPEC §5.4's "no silent truncation" applies to the summary
        // preview exactly as much as to a full output.
        //
        // The `include_outputs: "none"` branch above returns before this point, on purpose:
        // that caller asked not to see the outputs at all, so there is nothing to qualify.
        // (Measured before the fix: default 0 warnings, summary 0, full 3, none 0 — the first
        // two were the bug.)
        for (const lifted of collectOutputWarnings([{ outputs: mapped.items }])) {
          if (!warnings.some((warning) => warning.message === lifted.message)) {
            warnings.push(createWarning(lifted.code, lifted.message));
          }
        }
      }
      if (input.includeOutputs === 'full') {
        if (mapped.items.some((item) => item.kind === 'stream' && item.truncated)) {
          if (!warnings.some((warning) => warning.code === 'output_truncated')) {
            warnings.push(createWarning(
              'output_truncated',
              'at least one output exceeded inline_text_chars and was truncated',
            ));
          }
        }
      }
    }

    cellsPayload.push(cellPayload);
  }

  const payload: Record<string, unknown> = {
    path: input.path,
    nbformat: doc.nbformat,
    nbformat_minor: doc.nbformat_minor,
    kernel_name: kernelName,
    language_name: languageName,
    language_version: languageVersion,
    has_stable_cell_ids: hasStableCellIds(doc),
    cell_count: input.notebook.cells.length,
    content_hash: input.notebook.contentHash,
    cells: cellsPayload,
    warnings,
  };
  return { payload, imageBlocks };
}

interface OutputSummary {
  readonly kind: string;
  [key: string]: unknown;
}

function summarizeOutputs(items: readonly OutputItem[]): OutputSummary[] {
  return items.map((item) => {
    switch (item.kind) {
      case 'stream':
        return {
          kind: 'stream',
          stream_name: item.stream_name,
          line_count: item.text.split('\n').length,
          preview: truncatePreview(item.text),
        };
      case 'text':
        return { kind: 'text', line_count: item.text.split('\n').length, preview: truncatePreview(item.text) };
      case 'markdown':
        return { kind: 'markdown', line_count: item.text.split('\n').length, preview: truncatePreview(item.text) };
      case 'html':
        return { kind: 'html', line_count: item.html.split('\n').length, preview: truncatePreview(item.html) };
      case 'json':
        return { kind: 'json', preview: truncatePreview(JSON.stringify(item.value)) };
      case 'image':
        return {
          kind: 'image',
          media_type: item.media_type,
          width: item.width,
          height: item.height,
          bytes: item.bytes,
          artifact_path: null,
          image_index: null,
        };
      case 'error':
        return { kind: 'error', error_name: item.error_name, preview: truncatePreview(item.error_value) };
      case 'unsupported':
        return { kind: 'unsupported', mime_type: item.mime_type };
      default: {
        const exhaustive: never = item;
        return { kind: 'unsupported', mime_type: 'unknown', message: String(exhaustive) };
      }
    }
  });
}

function truncatePreview(text: string): string {
  if (text.length <= SUMMARY_PREVIEW_CHARS) {
    return text;
  }
  return `${text.slice(0, SUMMARY_PREVIEW_CHARS)}…`;
}
