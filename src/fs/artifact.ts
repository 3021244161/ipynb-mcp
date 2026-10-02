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
  /** Materialized images in return order (index within the returned image blocks). */
  readonly materialized: ReadonlyArray<{ outputIndex: number; artifactPath: string }>;
  readonly warnings: Warning[];
}

/**
 * Apply the image policy to mapped outputs: decide per image whether it is
 * materialized (and thus returned), fill artifact_path/image_index, and emit
 * image_limit / image_materialize_failed warnings. Items are mutated in place
 * on the image fields; decodeFailed images never materialize.
 */
export async function applyImagePolicy(
  items: OutputItem[],
  extractedImages: readonly ExtractedImage[],
  decision: ImagePolicyDecision,
  context: MaterializeContext,
): Promise<ApplyPolicyResult> {
  const warnings: Warning[] = [];
  const materialized: Array<{ outputIndex: number; artifactPath: string }> = [];

  if (!decision.returnImages || decision.maxImages <= 0) {
    if (decision.returnImages && decision.maxImages <= 0 && extractedImages.length > 0) {
      warnings.push(createWarning(
        'image_limit',
        `image count exceeds max_images_per_call (0); no images returned`,
      ));
    }
    return { items, materialized, warnings };
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
        `failed to decode image at output ${image.outputIndex}; artifact_path and image_index stay null`,
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
    try {
      await mkdir(path.dirname(artifactPath), { recursive: true });
      // Idempotent materialization: same content + same indexes -> same file,
      // never overwritten (SPEC §5.9).
      await writeFile(artifactPath, image.bytes, { flag: 'wx' });
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        warnings.push(createWarning(
          'image_materialize_failed',
          `failed to write artifact ${artifactPath}: ${String(cause)}`,
        ));
        continue;
      }
      // EEXIST: expected to be identical content, but a process death
      // mid-write leaves a truncated file that must never be served as the
      // artifact — verify the length and rewrite when it mismatches
      // (review A26).
      try {
        const existing = await stat(artifactPath);
        if (existing.size !== image.bytes.byteLength) {
          await writeFile(artifactPath, image.bytes);
        }
      } catch (statCause) {
        warnings.push(createWarning(
          'image_materialize_failed',
          `failed to verify existing artifact ${artifactPath}: ${String(statCause)}`,
        ));
        continue;
      }
    }
    const item = items[image.outputIndex];
    if (item !== undefined && item.kind === 'image') {
      item.artifact_path = artifactPath;
      item.image_index = imageIndex;
    }
    materialized.push({ outputIndex: image.outputIndex, artifactPath });
    imageIndex += 1;
  }

  return { items, materialized, warnings };
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
