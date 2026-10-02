// Shared tool context + argument validation helpers (SPEC §4.1.12):
// type/required checks are enforced by the SDK schema; enum/range/length/
// emptiness are validated HERE so they surface as invalid_arguments tool
// errors (U27), not protocol errors (DEVIATIONS D-006).

import type { IpynbConfig } from '../config.js';
import { IpynbError, type JsonValue } from '../core/errors.js';
import type { Hasher } from '../core/parse.js';
import { KernelRegistry } from '../kernel/registry.js';
import type { Logger } from '../log.js';
import { RunStore } from './run-store.js';
import { PathFence } from '../fs/fence.js';

export interface ToolContext {
  readonly config: IpynbConfig;
  readonly fence: PathFence;
  readonly registry: KernelRegistry;
  readonly runStore: RunStore;
  readonly hasher: Hasher;
  readonly logger: Logger;
  readonly realpath: (target: string) => string;
  readonly platform: NodeJS.Platform;
}

export function fieldPath(fields: readonly string[]): string {
  return fields.length === 1 ? (fields[0] ?? '') : fields.join('.');
}

export function invalidArguments(field: string, reason: string, detail?: JsonValue): IpynbError {
  return new IpynbError('invalid_arguments', `invalid argument '${field}': ${reason}`, {
    field,
    reason,
    ...(detail === undefined ? {} : { detail }),
  });
}

export function requireNonEmptyString(args: Record<string, unknown>, field: string): string {
  const value = args[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalidArguments(field, 'a non-empty string is required');
  }
  return value;
}

export function optionalString(args: Record<string, unknown>, field: string): string | undefined {
  const value = args[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw invalidArguments(field, 'must be a string');
  }
  return value;
}

export function optionalEnum<T extends string>(
  args: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = args[field];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw invalidArguments(field, `must be one of ${allowed.join('|')}`);
  }
  return value as T;
}

export function optionalInteger(
  args: Record<string, unknown>,
  field: string,
  min: number,
  max: number,
  fallback: number,
): number {
  const value = args[field];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw invalidArguments(field, `must be an integer in ${min}..${max}`);
  }
  return value;
}

export function optionalBoolean(args: Record<string, unknown>, field: string, fallback: boolean): boolean {
  const value = args[field];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'boolean') {
    throw invalidArguments(field, 'must be a boolean');
  }
  return value;
}

export function optionalIndexArray(
  args: Record<string, unknown>,
  field: string,
): number[] | undefined {
  const value = args[field];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw invalidArguments(field, 'must be an integer array');
  }
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 0) {
      throw invalidArguments(field, 'must contain non-negative integers');
    }
  }
  return [...value];
}

export function requireOpsArray(args: Record<string, unknown>, field: string): Array<Record<string, unknown>> {
  const value = args[field];
  if (!Array.isArray(value)) {
    throw invalidArguments(field, 'an array of op objects is required');
  }
  if (value.length < 1 || value.length > 32) {
    throw invalidArguments(field, `must contain 1..32 ops, got ${value.length}`);
  }
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw invalidArguments(field, 'every op must be an object');
    }
  }
  return value as Array<Record<string, unknown>>;
}
