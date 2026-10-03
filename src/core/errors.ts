// Single error type for the whole server (D13): stable `code` is the routing key
// for models and tests. Codes are a closed set (SPEC §7, 35 total) — adding one
// requires a SPEC change, not a code change.

/** JSON-safe value: everything we put in `detail` must survive JSON round-trips. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** All `error`-class codes (MCP isError: true when raised, SPEC §7). */
export const ERROR_CODES = [
  'path_outside_root',
  'file_not_found',
  'file_changed',
  'parse_failed',
  'nbformat_unsupported',
  'range_out_of_bounds',
  'cell_not_found',
  'invalid_arguments',
  'invalid_ops',
  'invalid_targets',
  'cas_mismatch',
  'markdown_invalid',
  'interpreter_not_found',
  'ipykernel_missing',
  'kernel_not_available',
  'kernel_died',
  'kernel_busy',
  'exec_timeout',
  'selfcheck_failed',
  'notebook_locked',
  'read_only_mode',
  'run_not_found',
  'cancelled',
  'internal',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** All `warning`-class codes (returned via `warnings[]`, never isError, SPEC §7). */
export const WARNING_CODES = [
  'no_stable_cell_id',
  'index_shifted',
  'large_markdown_rewrite',
  'kernelspec_mismatch',
  'file_changed_externally',
  'image_limit',
  'image_materialize_failed',
  'targets_ignored',
  'stale_analysis_skipped',
  'stale_analysis_degraded',
  'output_truncated',
] as const;

/**
 * The warning code used when a write PRESERVED content this tool would not have
 * written (a `display_data` without `metadata`, an `output_type` from a newer
 * nbformat, …).
 *
 * It is `file_changed_externally` on purpose: §7's table is a closed set, and the
 * v5 round minted a 12th code (`notebook_preexisting_content`) without
 * registering it as a deviation — a client that validates against the table
 * would have dropped the only signal the model got (review v6 WARN-CODE-1). Of
 * the eleven, this is the one whose trigger ("external change detected") is what
 * actually happened: the content came from outside this tool. The specific rule
 * and cell live in the warning's free-form `message`.
 */
export const PREEXISTING_CONTENT_WARNING: (typeof WARNING_CODES)[number] = 'file_changed_externally';

/**
 * Shared abort-cause test: did this throw come from OUR cancellation signal?
 *
 * One implementation for the whole repository. It used to exist twice — once in
 * `mcp/tools/edit.ts` and once in `run.ts`, byte-for-byte identical — which is a
 * drift surface for a rule that decides whether an error is reported as
 * `cancelled` or as a genuine failure (review v3 QUAL-2, still open in v6). It
 * lives in `core/errors.ts` because both layers may import it and neither layer
 * owns it.
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

export type WarningCode = (typeof WARNING_CODES)[number];

export class IpynbError extends Error {
  readonly code: ErrorCode;
  readonly detail?: JsonValue;

  constructor(code: ErrorCode, message: string, detail?: JsonValue) {
    super(message);
    this.name = 'IpynbError';
    this.code = code;
    this.detail = detail;
  }
}

/** Warning entries returned inside tool results (never isError). */
export interface Warning {
  readonly code: WarningCode;
  readonly message: string;
}

export function createWarning(code: WarningCode, message: string): Warning {
  return { code, message };
}
