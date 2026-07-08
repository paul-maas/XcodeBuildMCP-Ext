import { spawn } from 'child_process';
import { createWriteStream, existsSync } from 'fs';
import * as fsPromises from 'fs/promises';
import { tmpdir as osTmpdir } from 'os';
import { log } from './logger.ts';
import { transcriptEmitterStorage } from './transcript-context.ts';
import type { FileSystemExecutor } from './FileSystemExecutor.ts';
import type { CommandExecutor, CommandResponse, CommandExecOptions } from './CommandExecutor.ts';

export type { CommandExecutor, CommandResponse, CommandExecOptions } from './CommandExecutor.ts';
export type { FileSystemExecutor } from './FileSystemExecutor.ts';

/**
 * Ensure common tool directories (homebrew, MacPorts, user-local) are on PATH
 * so spawned commands like xcodegen, create-dmg, etc. are found regardless of
 * how the MCP server process was launched (stdio client, HTTP transport, Docker).
 */
const EXTRA_PATH_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin'];

// Grace period between SIGTERM and SIGKILL for aborted process groups.
// xcodebuild catches SIGTERM and runs its own cleanup; revisit if flake logs
// show truncated xcresult bundles.
const KILL_GRACE_MS = 10_000;
const enrichedPath: string = (() => {
  const current = process.env.PATH ?? '';
  const currentDirs = current.split(':');
  const missing = EXTRA_PATH_DIRS.filter((d) => existsSync(d) && !currentDirs.includes(d));
  return missing.length ? `${missing.join(':')}:${current}` : current;
})();

async function defaultExecutor(
  command: string[],
  logPrefix?: string,
  useShell: boolean = false,
  opts?: CommandExecOptions,
  detached: boolean = false,
): Promise<CommandResponse> {
  let escapedCommand = command;
  if (useShell) {
    const commandString = command
      .map((arg) => {
        if (/[\s,"'=$`;&|<>(){}[\]\\*?~]/.test(arg) && !/^".*"$/.test(arg)) {
          return `"${arg.replace(/(["\\])/g, '\\$1')}"`;
        }
        return arg;
      })
      .join(' ');

    escapedCommand = ['/bin/sh', '-c', commandString];
  }

  return new Promise((resolve, reject) => {
    let executable = escapedCommand[0];
    let args = escapedCommand.slice(1);

    if (!useShell && executable === 'xcodebuild') {
      const xcrunPath = '/usr/bin/xcrun';
      if (existsSync(xcrunPath)) {
        executable = xcrunPath;
        args = ['xcodebuild', ...args];
      }
    }

    const displayCommand =
      useShell && escapedCommand.length === 3 ? escapedCommand[2] : [executable, ...args].join(' ');
    log('debug', `Executing ${logPrefix ?? ''} command: ${displayCommand}`);

    const emitTranscript = transcriptEmitterStorage.getStore();
    if (emitTranscript) {
      emitTranscript({ kind: 'transcript', fragment: 'process-command', displayCommand });
    }

    const spawnOpts: Parameters<typeof spawn>[2] = {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: enrichedPath, ...opts?.env },
      cwd: opts?.cwd,
      // OS-level detachment (own process group) is driven solely by the
      // processGroup option; the positional `detached` parameter only changes
      // when the promise resolves (see CommandExecutor.ts).
      detached: opts?.processGroup === true,
      signal: opts?.signal,
    };

    log('debug', `defaultExecutor PATH: ${process.env.PATH ?? ''}`);

    const logSpawnError = (err: Error): void => {
      const errnoErr = err as NodeJS.ErrnoException & { spawnargs?: string[] };
      const errorDetails = {
        code: errnoErr.code,
        errno: errnoErr.errno,
        syscall: errnoErr.syscall,
        path: errnoErr.path,
        spawnargs: errnoErr.spawnargs,
        stack: errnoErr.stack,
      };
      log('error', `Spawn error details: ${JSON.stringify(errorDetails, null, 2)}`);
    };

    // Abort → SIGTERM the whole process group, escalating to SIGKILL after a
    // grace period. spawnOpts.signal already terminates the direct child; the
    // group kill reaches its descendants (xcrun → xcodebuild → test runners).
    let removeAbortListener: (() => void) | undefined;
    let killGroupIfAlreadyAborted: (() => void) | undefined;
    if (opts?.signal && opts.processGroup === true) {
      const abortSignal = opts.signal;
      const killProcessGroup = (killSignal: NodeJS.Signals): void => {
        if (childProcess.pid === undefined) {
          return;
        }
        try {
          process.kill(-childProcess.pid, killSignal);
        } catch {
          // Process group already gone.
        }
      };
      const onAbort = (): void => {
        killProcessGroup('SIGTERM');
        const escalation = setTimeout(() => {
          if (childProcess.exitCode === null && childProcess.signalCode === null) {
            killProcessGroup('SIGKILL');
          }
        }, KILL_GRACE_MS);
        escalation.unref();
        childProcess.once('exit', () => clearTimeout(escalation));
      };
      if (abortSignal.aborted) {
        killGroupIfAlreadyAborted = onAbort;
      } else {
        // Registered BEFORE spawn(): Node's own spawn-signal listener emits
        // AbortError synchronously during the abort dispatch, which settles
        // the promise; registering after spawn would let that settle path
        // remove this listener mid-dispatch, before it ever fired.
        abortSignal.addEventListener('abort', onAbort, { once: true });
        removeAbortListener = (): void => abortSignal.removeEventListener('abort', onAbort);
      }
    }

    const childProcess = spawn(executable, args, spawnOpts);
    killGroupIfAlreadyAborted?.();

    let stdout = '';
    let stderr = '';

    const streamClosers: Array<() => void> = [];
    const streamDetachers: Array<() => void> = [];
    let openStreamCount = 0;
    let settled = false;
    let exitObserved = false;
    let exitCode: number | null = null;
    let exitSettleTimer: NodeJS.Timeout | null = null;

    const clearExitSettleTimer = (): void => {
      if (exitSettleTimer) {
        clearTimeout(exitSettleTimer);
        exitSettleTimer = null;
      }
    };

    const detachStreamListeners = (): void => {
      for (const detachStream of streamDetachers) {
        detachStream();
      }
      streamDetachers.length = 0;
    };

    const handleError = (err: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearExitSettleTimer();
      detachStreamListeners();
      removeAbortListener?.();
      logSpawnError(err);
      reject(err);
    };

    const settle = (code: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearExitSettleTimer();
      detachStreamListeners();
      removeAbortListener?.();

      const success = code === 0;
      const response: CommandResponse = {
        success,
        output: stdout,
        error: success ? undefined : stderr,
        process: childProcess,
        exitCode: code ?? undefined,
      };

      resolve(response);
    };

    const maybeSettleAfterExit = (): void => {
      if (!exitObserved || settled || openStreamCount > 0) {
        return;
      }
      settle(exitCode);
    };

    const scheduleExitSettle = (): void => {
      if (settled || exitSettleTimer) {
        return;
      }
      exitSettleTimer = setTimeout(() => {
        settle(exitCode);
      }, 100);
    };

    const attachStream = (
      stream: NodeJS.ReadableStream | null | undefined,
      onChunk: (chunk: string) => void,
    ): void => {
      if (!stream) {
        return;
      }

      openStreamCount += 1;
      let streamClosed = false;

      const markClosed = (): void => {
        if (streamClosed) {
          return;
        }
        streamClosed = true;
        openStreamCount = Math.max(0, openStreamCount - 1);
        maybeSettleAfterExit();
      };

      const handleData = (data: Buffer | string): void => {
        if (settled) {
          return;
        }
        const chunk = data.toString();
        onChunk(chunk);
      };

      stream.on('data', handleData);
      stream.once('end', markClosed);
      stream.once('close', markClosed);
      streamClosers.push(markClosed);
      streamDetachers.push(() => {
        stream.off('data', handleData);
      });
    };

    if (detached) {
      let resolved = false;

      childProcess.on('error', (err) => {
        if (!resolved) {
          resolved = true;
          logSpawnError(err);
          reject(err);
        }
      });

      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          if (childProcess.pid) {
            resolve({
              success: true,
              output: '',
              process: childProcess,
            });
          } else {
            resolve({
              success: false,
              output: '',
              error: 'Failed to start detached process',
              process: childProcess,
            });
          }
        }
      }, 100);
      return;
    }

    attachStream(childProcess.stdout, (chunk) => {
      stdout += chunk;
      opts?.onStdout?.(chunk);
      emitTranscript?.({
        kind: 'transcript',
        fragment: 'process-line',
        stream: 'stdout',
        line: chunk,
      });
    });

    attachStream(childProcess.stderr, (chunk) => {
      stderr += chunk;
      opts?.onStderr?.(chunk);
      emitTranscript?.({
        kind: 'transcript',
        fragment: 'process-line',
        stream: 'stderr',
        line: chunk,
      });
    });

    childProcess.once('error', handleError);
    childProcess.once('exit', (code) => {
      exitObserved = true;
      exitCode = code;
      maybeSettleAfterExit();
      scheduleExitSettle();
    });
    childProcess.once('close', (code) => {
      clearExitSettleTimer();
      for (const closeStream of streamClosers) {
        closeStream();
      }
      settle(code ?? exitCode);
    });
  });
}

const defaultFileSystemExecutor: FileSystemExecutor = {
  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await fsPromises.mkdir(path, options);
  },

  readFile(path: string, encoding: BufferEncoding = 'utf8'): Promise<string> {
    return fsPromises.readFile(path, encoding);
  },

  writeFile(path: string, content: string, encoding: BufferEncoding = 'utf8'): Promise<void> {
    return fsPromises.writeFile(path, content, encoding);
  },

  createWriteStream(path: string, options?: { flags?: string }) {
    return createWriteStream(path, options);
  },

  cp(source: string, destination: string, options?: { recursive?: boolean }): Promise<void> {
    return fsPromises.cp(source, destination, options);
  },

  readdir(path: string, options?: { withFileTypes?: boolean }): Promise<unknown[]> {
    return fsPromises.readdir(path, options as Record<string, unknown>);
  },

  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    return fsPromises.rm(path, options);
  },

  existsSync(path: string): boolean {
    return existsSync(path);
  },

  stat(path: string): Promise<{ isDirectory(): boolean; mtimeMs: number }> {
    return fsPromises.stat(path);
  },

  mkdtemp(prefix: string): Promise<string> {
    return fsPromises.mkdtemp(prefix);
  },

  tmpdir(): string {
    return osTmpdir();
  },
};

let _testCommandExecutorOverride: CommandExecutor | null = null;
let _testFileSystemExecutorOverride: FileSystemExecutor | null = null;

export function __setTestCommandExecutorOverride(executor: CommandExecutor | null): void {
  _testCommandExecutorOverride = executor;
}

export function __setTestFileSystemExecutorOverride(executor: FileSystemExecutor | null): void {
  _testFileSystemExecutorOverride = executor;
}

export function __clearTestExecutorOverrides(): void {
  _testCommandExecutorOverride = null;
  _testFileSystemExecutorOverride = null;
}

export function __getRealCommandExecutor(): CommandExecutor {
  return defaultExecutor;
}

export function __getRealFileSystemExecutor(): FileSystemExecutor {
  return defaultFileSystemExecutor;
}

export function getDefaultCommandExecutor(): CommandExecutor {
  return _testCommandExecutorOverride ?? defaultExecutor;
}

export function getDefaultFileSystemExecutor(): FileSystemExecutor {
  return _testFileSystemExecutorOverride ?? defaultFileSystemExecutor;
}
