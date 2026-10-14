// Image artifacts (SPEC §4.4, §5.9): materializing an image (base64 -> file)
// and returning it as an MCP image block are THE SAME event. Suppressed
// images keep artifact_path/image_index null and write nothing.
//
// Path scheme: <root>/<sha1(normalize(notebook)).slice(0,16)>/cell-<c>-out-<o>-<sha256[:8]>.<ext>
// Idempotent: the same content at the same cell/output index maps to the same
// file; an existing file is never overwritten.

import { createHash } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createWarning, type Warning } from '../core/errors.js';
import type { ExtractedImage, OutputItem } from '../core/outputs.js';
import { normalizeForCompare } from '../config.js';

export type ImagesPolicy = 'auto' | 'never' | 'always';

export interface ImagePolicyDecision {
  /** Whether image blocks will be returned in this call at all. */
  readonly returnImages: boolean;
  readonly maxImages: number;
  /**
   * 0-based position of this batch's first image within the WHOLE call's
   * image blocks (SPEC §4.3: image_index is unique across the call, not per
   * cell — read/run loop over cells and must pass a running cursor).
   */
  readonly indexStart?: number;
  /** The MCP result boundary decides which blocks fit before any artifact is written. */
  readonly deferWrites?: boolean;
}

export interface ImageArtifactPlan {
  readonly imageIndex: number;
  readonly artifactPath: string;
  readonly base64: string;
}

export interface MaterializeContext {
  readonly artifactRoot: string;
  readonly notebookAbsPath: string;
  readonly cellIndex: number;
  readonly platform: NodeJS.Platform;
  readonly realpath: (target: string) => string;
}

export interface ApplyPolicyResult {
  readonly items: OutputItem[];
  /**
   * Materialized images in return order (index within the returned image blocks).
   *
   * `base64` is the payload the corresponding image block must carry — the exact
   * bytes that were just written, encoded once. It travels with the decision so a
   * caller never has to look the value up in the document again: doing that is
   * what made a `data:` URL decodable for the artifact and fatal for the block
   * (review v9 V9-1).
   */
  readonly materialized: ReadonlyArray<{ outputIndex: number; artifactPath: string; base64: string }>;
  readonly warnings: Warning[];
  readonly artifactPlans: readonly ImageArtifactPlan[];
}

/**
 * Apply the image policy to mapped outputs: decide per image whether it is
 * materialized (and thus returned), fill artifact_path/image_index, and emit
 * image_limit / image_materialize_failed warnings. Items are mutated in place
 * on the image fields; decodeFailed images never materialize.
 */
/**
 * A materialize failure that NAMES the cell, so callers can be told apart after dedup.
 *
 * The message used to carry only the output index, and every cell's outputs start at 0 — so
 * three cells each holding a broken image produced three identical strings: the read path
 * printed the same line three times with no way to tell where they came from, and the run path
 * deduplicated them to one, discarding exactly the "which cells" information the model needs
 * (review v11 V11-10). The cell is part of the message now, which makes both behaviours
 * correct: identical messages mean identical facts, and distinct facts stay distinct.
 */
function imageFailureMessage(image: ExtractedImage, reason: string): string {
  const where = image.cellIndex === null ? `output ${String(image.outputIndex)}` : `cell ${String(image.cellIndex)} (output ${String(image.outputIndex)})`;
  return `image at ${where} ${reason}; artifact_path and image_index stay null`;
}

export async function applyImagePolicy(
  items: OutputItem[],
  extractedImages: readonly ExtractedImage[],
  decision: ImagePolicyDecision,
  context: MaterializeContext,
): Promise<ApplyPolicyResult> {
  const warnings: Warning[] = [];
  const materialized: Array<{ outputIndex: number; artifactPath: string; base64: string }> = [];
  const artifactPlans: ImageArtifactPlan[] = [];

  if (!decision.returnImages || decision.maxImages <= 0) {
    if (decision.returnImages && decision.maxImages <= 0 && extractedImages.length > 0) {
      warnings.push(createWarning(
        'image_limit',
        `image count exceeds max_images_per_call (0); no images returned`,
      ));
    }
    return { items, materialized, warnings, artifactPlans };
  }

  const dirKey = createHash('sha1')
    .update(normalizeForCompare(context.realpath(context.notebookAbsPath), context.platform))
    .digest('hex')
    .slice(0, 16);

  let imageIndex = decision.indexStart ?? 0;
  let limitWarned = false;
  for (const image of extractedImages) {
    if (image.decodeFailed) {
      warnings.push(createWarning(
        'image_materialize_failed',
        imageFailureMessage(image, 'failed to decode'),
      ));
      continue;
    }
    // A decodable image always has a canonical payload (see `ExtractedImage.base64`).
    // Serving a block without one is the one outcome that must not happen, so it is
    // reported as the documented materialize failure rather than as a raw value the
    // SDK would reject with a protocol error (review v9 V9-1/V9-3).
    const base64 = image.base64;
    if (base64 === null) {
      warnings.push(createWarning(
        'image_materialize_failed',
        imageFailureMessage(image, 'has no returnable base64 payload'),
      ));
      continue;
    }
    if (imageIndex >= decision.maxImages) {
      if (!limitWarned) {
        limitWarned = true;
        warnings.push(createWarning(
          'image_limit',
          `image count exceeds max_images_per_call (${decision.maxImages}); extra images are not returned`,
        ));
      }
      continue;
    }
    const ext = image.mediaType === 'image/png' ? 'png' : 'jpg';
    const fileName = `cell-${context.cellIndex}-out-${image.outputIndex}-${image.sha256Hex.slice(0, 8)}.${ext}`;
    const artifactPath = path
      .join(context.artifactRoot, dirKey, fileName)
      .replace(/\\/g, '/');
    const plan = { imageIndex, artifactPath, base64 };
    if (decision.deferWrites) {
      artifactPlans.push(plan);
    } else {
      const failure = await materializeImageArtifact(plan);
      if (failure !== null) {
        warnings.push(failure);
        continue;
      }
    }
    const item = items[image.outputIndex];
    if (item !== undefined && item.kind === 'image') {
      item.artifact_path = artifactPath;
      item.image_index = imageIndex;
    }
    materialized.push({ outputIndex: image.outputIndex, artifactPath, base64 });
    imageIndex += 1;
  }

  return { items, materialized, warnings, artifactPlans };
}

export async function materializeImageArtifact(plan: ImageArtifactPlan): Promise<Warning | null> {
  const bytes = Buffer.from(plan.base64, 'base64');
  try {
    await mkdir(path.dirname(plan.artifactPath), { recursive: true });
    await writeFile(plan.artifactPath, bytes, { flag: 'wx' });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') {
      return createWarning('image_materialize_failed', `failed to write artifact ${plan.artifactPath}: ${String(cause)}`);
    }
    try {
      const existing = await stat(plan.artifactPath);
      if (existing.size !== bytes.byteLength) {
        await writeFile(plan.artifactPath, bytes);
      }
    } catch (statCause) {
      return createWarning('image_materialize_failed', `failed to verify existing artifact ${plan.artifactPath}: ${String(statCause)}`);
    }
  }
  return null;
}

/**
 * Whether a call should return image blocks (SPEC §4.4 policy table).
 * `outputsFull` refers to include_outputs='full' on reads; run calls pass true.
 */
export function shouldReturnImages(
  policy: ImagesPolicy,
  outputsFull: boolean,
): boolean {
  if (policy === 'never') {
    return false;
  }
  if (policy === 'always') {
    return true;
  }
  return outputsFull;
}
