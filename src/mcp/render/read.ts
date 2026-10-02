// notebook_read projection (SPEC §4.3): the model-facing JSON payload plus
// image blocks. Source previews and output summaries keep the default read
// cheap (no kernel, no artifacts); full outputs materialize images only when
// the image policy allows blocks to be returned.

import { createWarning, type Warning } from '../../core/errors.js';
import { mapRawOutputs, type OutputItem, type RawOutput } from '../../core/outputs.js';
import { cellSource, readNotebookMetadata, type NotebookFile } from '../../core/parse.js';
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

  const imageBudgetTotal = input.maxImagesPerCall;
  let imageBudget = imageBudgetTotal;
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
      execution_count: cell.cell_type === 'code' ? (cell.execution_count ?? null) : null,
      source_preview: lines.slice(0, sourcePreviewCount),
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
      const rawOutputs = (cell.outputs ?? []) as unknown[];
      const typedRawOutputs: RawOutput[] = rawOutputs.map((entry) => normalizeRawOutput(entry));
      const mapped = mapRawOutputs(typedRawOutputs, {
        inlineTextChars: input.inlineTextChars,
        maxImageBytes: input.maxImageBytes,
        hasher: input.hasher,
      });
      const returnImages = shouldReturnImages(input.imagesPolicy, input.includeOutputs === 'full');
      const budgeted = returnImages ? Math.min(imageBudget, input.maxImagesPerCall) : 0;
      if (returnImages && budgeted < mapped.extractedImages.length && !limitWarned) {
        limitWarned = true;
        warnings.push(createWarning(
          'image_limit',
          `image count exceeds max_images_per_call (${input.maxImagesPerCall}); extra images are not returned`,
        ));
      }
      const policyResult = await applyImagePolicy(
        mapped.items,
        mapped.extractedImages,
        { returnImages, maxImages: budgeted, indexStart: imageCursor },
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
      imageBudget -= policyResult.materialized.length;
      if (returnImages) {
        for (const materialized of policyResult.materialized) {
          const rawOutput = typedRawOutputs[materialized.outputIndex];
          const image = mapped.items[materialized.outputIndex];
          if (image !== undefined && image.kind === 'image') {
            const base64 = rawOutput?.data?.[image.media_type];
            if (base64 !== undefined) {
              imageBlocks.push({ data: base64, media_type: image.media_type });
            }
          }
        }
      }

      cellPayload['outputs_summary'] = input.includeOutputs === 'summary' ? summarizeOutputs(mapped.items) : null;
      cellPayload['outputs'] = input.includeOutputs === 'full' ? mapped.items : null;
      if (input.includeOutputs === 'full' && mapped.items.some((item) => item.kind === 'stream' && item.truncated)) {
        if (!warnings.some((warning) => warning.code === 'output_truncated')) {
          warnings.push(createWarning(
            'output_truncated',
            'at least one output exceeded inline_text_chars and was truncated',
          ));
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
    has_stable_cell_ids: doc.nbformat_minor >= 5,
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

/** nbformat outputs are loosely typed in the parsed tree; narrow defensively. */
function normalizeRawOutput(entry: unknown): RawOutput {
  if (typeof entry !== 'object' || entry === null) {
    return { outputType: 'display_data', data: {} };
  }
  const record = entry as Record<string, unknown>;
  const outputType = record['output_type'];
  const rawOutput: RawOutput = {
    outputType:
      outputType === 'stream' || outputType === 'error' || outputType === 'execute_result' || outputType === 'display_data'
        ? outputType
        : 'display_data',
  };
  const data = record['data'];
  if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
    rawOutput.data = Object.fromEntries(
      Object.entries(data as Record<string, unknown>)
        .filter(([, value]) => typeof value === 'string')
        .map(([key, value]) => [key, value as string]),
    );
  }
  if (typeof record['text'] === 'string') {
    rawOutput.text = record['text'];
  } else if (Array.isArray(record['text'])) {
    rawOutput.text = (record['text'] as unknown[]).map(String).join('');
  }
  if (record['name'] === 'stderr' || record['name'] === 'stdout') {
    rawOutput.name = record['name'];
  }
  if (typeof record['ename'] === 'string') {
    rawOutput.ename = record['ename'];
  }
  if (typeof record['evalue'] === 'string') {
    rawOutput.evalue = record['evalue'];
  }
  if (Array.isArray(record['traceback'])) {
    rawOutput.traceback = (record['traceback'] as unknown[]).map(String);
  }
  const metadata = record['metadata'];
  if (typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)) {
    rawOutput.metadata = metadata as Record<string, unknown>;
  }
  return rawOutput;
}
