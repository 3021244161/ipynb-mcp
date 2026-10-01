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
