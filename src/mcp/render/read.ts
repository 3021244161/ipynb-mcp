// notebook_read projection (SPEC §4.3): the model-facing JSON payload plus
// image blocks. Source previews and output summaries keep the default read
// cheap (no kernel, no artifacts); full outputs materialize images only when
// the image policy allows blocks to be returned.

import { createWarning, type JsonValue, type Warning } from '../../core/errors.js';
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

/**
 * Make the structured completeness flags agree with what is actually being delivered.
 *
 * `source_truncated` is the signal a model uses to decide whether the source it holds is the whole source
 * (SPEC §4.1 defines it as "whether the preview was truncated"). The RESPONSE BUDGET can shorten `source` or
 * `source_preview` after they have been projected — and it edits JSON, so it cannot know that a boolean beside
 * the value is supposed to describe it. Measured before this ran: a 12 MiB source arrived as 8 387 552
 * characters ending in the truncation marker while the payload said `source_truncated: false` — a structural
 * field asserting the opposite of the truth, which is worse than no field at all because a model that reads
 * the flag rather than the tail concludes the source is complete (review v16 V16-1).
 *
 * The budget reports WHICH fields it cut, and this function — the layer that knows what those fields mean —
 * reconciles the flags. A cut is a cut whichever stage made it, so the value is set to `true`; nothing here
 * can set it back to `false`, because only a re-projection could do that and none happens after the budget.
 */
export function reconcileTruncationFlags(payload: JsonValue, truncatedFields: readonly string[]): JsonValue {
  if (truncatedFields.length === 0) {
    return payload;
  }
  const affected = new Set(truncatedFields);
  // Two field families carry a completeness flag: the cell's source (`source_truncated`, SPEC §4.1) and a
  // `stream` item's text (`truncated`, SPEC §5.4). Either alone is worth reconciling, and a cut in an unrelated
  // field (`value`, `html`) needs no flag because the SPEC gives those item kinds none.
  const touchesSource = affected.has('source') || affected.has('source_preview');
  const touchesStreamText = affected.has('text');
  if (!touchesSource && !touchesStreamText) {
    return payload;
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return payload;
  }
  const record = payload as Record<string, JsonValue>;
  const cells = record['cells'];
  if (!Array.isArray(cells)) {
    return payload;
  }
  const cutMarker = 'truncated to fit the response budget]';
  const endsCut = (value: unknown): boolean => typeof value === 'string' && value.endsWith(cutMarker);
  for (const entry of cells) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      continue;
    }
    const cell = entry as Record<string, JsonValue>;
    // Per-OUTPUT flags first. SPEC §5.4 gives `truncated`/`truncated_at_chars` to `stream` items, and a stream
    // can be cut by the budget like anything else: measured in a 25-cell notebook whose outputs totalled 35 MB,
    // 39 items came back carrying the cut marker INSIDE `text` while their `truncated` still said `false` — the
    // same "structured field contradicts its value" defect as the reported one. The other item kinds (`text`,
    // `html`, `markdown`, `json`, `error`) have no completeness field in the SPEC's shape, so the marker inside
    // the value is all they can carry; where a field does exist, leaving it false is a lie the model acts on.
    const outputs = cell['outputs'];
    if (touchesStreamText && Array.isArray(outputs)) {
      for (const item of outputs as JsonValue[]) {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) {
          continue;
        }
        const stream = item as Record<string, JsonValue>;
        if (stream['kind'] === 'stream' && endsCut(stream['text'])) {
          stream['truncated'] = true;
        }
      }
    }
    // PER CELL, NOT PER CALL. The first version flagged every cell that delivered anything as soon as `source`
    // appeared in the cut list — so a 4-character cell was reported truncated in the same response as a 12 MiB
    // one, while its own value was byte-for-byte complete. Sweeping the payload for this defect class is how
    // that surfaced, and the fix is to ask the cell's OWN value instead of the call's summary.
    //
    // The cut marker is the exact signal, and it is set by the budget at the moment it cuts: any cell whose
    // delivered source does not end there is complete. No arithmetic on line counts, because Jupyter's own
    // convention (`source` is an array of lines, all but the last ending in `\n`, plus a trailing empty element
    // from `split('\n')`) makes `source_line_count` differ by one from the line count of the text a caller would
    // derive, and a comparison that is off by one in the wrong direction would flag complete cells.
    const deliveredSource = cell['source'];
    const preview = cell['source_preview'];
    let wasCut = endsCut(deliveredSource);
    if (!wasCut && Array.isArray(preview)) {
      const elements = preview as JsonValue[];
      wasCut = elements.length > 0 && typeof elements[elements.length - 1] === 'string' && endsCut(elements[elements.length - 1]);
    }
    if (wasCut) {
      // This cell was cut, whichever field carried the cut.
      cell['source_truncated'] = true;
      continue;
    }
    // Not cut in the value. `source_truncated` was already true when a `preview` request deliberately shows
    // fewer lines than the cell has, and that stays true — a cut is a cut whichever stage made it.
  }
  return payload;
}

/** The completeness fields a summary item carries; kind is added by the caller. */
interface SummaryMeasurement {
  readonly truncated: boolean;
  readonly line_count?: number;
  readonly truncated_at_chars?: number;
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
          ...measuredLines(item.text, item.truncated_at_chars),
          preview: truncatePreview(item.text),
        };
      case 'text':
        return { kind: 'text', ...measuredLines(item.text, null), preview: truncatePreview(item.text) };
      case 'markdown':
        return { kind: 'markdown', ...measuredLines(item.text, null), preview: truncatePreview(item.text) };
      case 'html':
        return { kind: 'html', ...measuredLines(item.html, null), preview: truncatePreview(item.html) };
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

/**
 * `line_count` for a summary item — the field a model reads to judge an output's SIZE from a short preview.
 *
 * This used to be `item.text.split('\n').length`, computed on text that `inlineTextChars` had ALREADY cut at
 * 20 000 characters (default). An 11 MiB single-line stream then summarized as `line_count: 1` beside a 200
 * character preview: every signal in the summary said "one line, nothing to see", when the truth was one line
 * of eleven megabytes. A model that trusts the summary concludes there is nothing more to fetch — the same
 * defect class as `source_truncated` claiming a cut source was whole (review v16 V16-1), and it was found by
 * sweeping the payload for that class rather than fixing only the reported field.
 *
 * `line_count` is OPTIONAL in SPEC §4.1's summary shape, so the honest answer for a cut output is to leave it
 * out and state the bound that IS known: the item records where it was cut. Omitting a number the summary
 * cannot know is honest; a confidently wrong one is what this round is about.
 */
function measuredLines(text: string, truncatedAtChars: number | null): SummaryMeasurement {
  if (truncatedAtChars !== null) {
    return { truncated: true, truncated_at_chars: truncatedAtChars };
  }
  return { truncated: false, line_count: text.split('\n').length };
}

function truncatePreview(text: string): string {
  if (text.length <= SUMMARY_PREVIEW_CHARS) {
    return text;
  }
  return `${text.slice(0, SUMMARY_PREVIEW_CHARS)}…`;
}
