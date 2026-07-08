import { ChildProcess } from 'child_process';

// Runtime marker to prevent empty output in unbundled builds
export const _typeModule = true as const;

export interface CommandExecOptions {
  env?: Record<string, string>;
  cwd?: string;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /**
   * Abort the spawned process when the signal fires. Opt-in per call — never
   * set for long-lived sessions (log/video capture, debugger, daemon), which
   * must outlive the request that started them.
   */
  signal?: AbortSignal;
  /**
   * Spawn the child in its own process group so an abort can kill every
   * descendant with a single `process.kill(-pid, ...)` (e.g. xcodebuild and
   * its test runners). Distinct from the positional `detached` parameter,
   * which only changes when the promise resolves.
   */
  processGroup?: boolean;
}

/**
 * NOTE: `detached` only changes when the promise resolves; it does not detach/unref
 * the OS process. Callers must still manage lifecycle and open streams.
 */
export type CommandExecutor = (
  command: string[],
  logPrefix?: string,
  useShell?: boolean,
  opts?: CommandExecOptions,
  detached?: boolean,
) => Promise<CommandResponse>;

export interface CommandResponse {
  success: boolean;
  output: string;
  error?: string;
  process: ChildProcess;
  exitCode?: number;
}
