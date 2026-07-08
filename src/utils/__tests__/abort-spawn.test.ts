import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { __getRealCommandExecutor } from '../command.ts';
import type { CommandResponse } from '../CommandExecutor.ts';

const executor = __getRealCommandExecutor();

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  condition: () => boolean,
  what: string,
  timeoutMs = 5000,
  stepMs = 50,
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

/** The aborted executor promise may reject (AbortError) or resolve as a failed command; both are acceptable terminal states. */
async function settleAborted(promise: Promise<CommandResponse>): Promise<void> {
  try {
    await promise;
  } catch {
    // AbortError via spawn's signal option — expected.
  }
}

describe('abort-spawn (real processes)', () => {
  let workDir: string;

  afterEach(() => {
    if (workDir) {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('delivers SIGTERM to the root process on abort', async () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'abort-spawn-'));
    const markerFile = path.join(workDir, 'got-term');
    const controller = new AbortController();

    const promise = executor(
      ['sh', '-c', `trap 'echo yes > ${markerFile}; exit 143' TERM; sleep 30 & wait $!`],
      'abort-test-root',
      false,
      { signal: controller.signal, processGroup: true },
    );

    // Give the shell a moment to install its trap before aborting.
    await new Promise((resolve) => setTimeout(resolve, 200));
    controller.abort();
    await settleAborted(promise);

    await waitFor(() => existsSync(markerFile), 'SIGTERM trap marker file');
  }, 15_000);

  it('kills the entire process group, including grandchildren', async () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'abort-spawn-'));
    const pidFile = path.join(workDir, 'grandchild.pid');
    const controller = new AbortController();

    const promise = executor(
      ['sh', '-c', `sleep 60 & echo $! > ${pidFile}; wait`],
      'abort-test-group',
      false,
      { signal: controller.signal, processGroup: true },
    );

    await waitFor(() => existsSync(pidFile), 'grandchild pid file');
    const grandchildPid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(Number.isInteger(grandchildPid)).toBe(true);
    expect(isAlive(grandchildPid)).toBe(true);

    controller.abort();
    await settleAborted(promise);

    await waitFor(() => !isAlive(grandchildPid), 'grandchild to die with the process group');
  }, 15_000);

  it('does not affect concurrent spawns that opted out of the signal', async () => {
    const controller = new AbortController();

    // Long-lived session-style spawn: no signal, detached resolution semantics
    // (resolves with the process handle while the command keeps running).
    const session = await executor(['sleep', '30'], 'abort-test-session', false, undefined, true);
    const sessionPid = session.process.pid;
    expect(sessionPid).toBeDefined();
    expect(isAlive(sessionPid!)).toBe(true);

    try {
      const aborted = executor(['sleep', '30'], 'abort-test-cancelled', false, {
        signal: controller.signal,
        processGroup: true,
      });
      controller.abort();
      await settleAborted(aborted);

      // The unrelated session process must survive the abort.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(isAlive(sessionPid!)).toBe(true);
    } finally {
      session.process.kill('SIGKILL');
    }
  }, 15_000);
});
