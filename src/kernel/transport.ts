// KernelTransport interface (D3): isolates the sidecar implementation so a
// pure-Node ZMQ transport can replace it later without touching callers.

import type { RawOutput } from '../core/outputs.js';

export interface PingResult {
  readonly pythonVersion: string;
  readonly jupyterClientVersion: string;
  readonly ipykernelVersion: string;
}

export interface StartKernelParams {
  readonly kernelId: string;
  readonly interpreterPath: string;
  readonly kernelSpecName: string;
  readonly language: string;
}

export interface StartKernelResult {
  readonly pid: number | null;
  readonly kernelSpecName: string;
  readonly language: string;
}

export interface ExecCellParams {
  readonly kernelId: string;
  readonly code: string;
  readonly silent: boolean;
  readonly storeOutputs: boolean;
  readonly timeoutMs: number;
}

export interface ExecCellResult {
  readonly status: 'ok' | 'error' | 'timeout';
  readonly executionCount: number | null;
  readonly rawOutputs: RawOutput[];
  readonly durationMs: number;
}

export interface KernelStatusResult {
  readonly alive: boolean;
  readonly executionCount: number | null;
  readonly pid: number | null;
}

export interface AnalyzeResult {
  readonly ok: boolean;
  readonly failedCellIndexes: number[];
  readonly defs: string[][];
  readonly uses: string[][];
}

export interface KernelTransport {
  ping(): Promise<PingResult>;
  startKernel(params: StartKernelParams): Promise<StartKernelResult>;
  execCell(params: ExecCellParams): Promise<ExecCellResult>;
  interrupt(kernelId: string): Promise<void>;
  shutdownKernel(kernelId: string): Promise<void>;
  kernelStatus(kernelId: string): Promise<KernelStatusResult>;
  analyze(sources: readonly string[]): Promise<AnalyzeResult>;
  shutdownAll(): Promise<void>;
  /** Register a callback fired when a kernel dies unexpectedly. */
  onKernelDied(callback: (kernelId: string) => void): void;
  /** Whether the sidecar process is still running. */
  readonly alive: boolean;
}
