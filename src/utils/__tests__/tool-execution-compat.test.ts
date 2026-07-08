import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startMcpProgressPump } from '../tool-execution-compat.ts';

describe('startMcpProgressPump', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits an immediate progress then ticks on the interval with a monotonic counter', () => {
    const sent: Array<{ progress: number; total?: number; message?: string }> = [];
    const pump = startMcpProgressPump((p) => sent.push(p), 1000);

    // Immediate tick at t=0 so the SSE stream carries data right away.
    expect(sent).toHaveLength(1);
    expect(sent[0].progress).toBe(0);
    // Indeterminate progress: no total.
    expect(sent[0].total).toBeUndefined();

    vi.advanceTimersByTime(3000);
    expect(sent.map((s) => s.progress)).toEqual([0, 1, 2, 3]);

    pump.stop();
  });

  it('stop() halts further notifications', () => {
    const sent: number[] = [];
    const pump = startMcpProgressPump((p) => sent.push(p.progress), 500);

    vi.advanceTimersByTime(1000);
    const countAfterRun = sent.length;
    expect(countAfterRun).toBeGreaterThan(1);

    pump.stop();
    vi.advanceTimersByTime(5000);
    expect(sent).toHaveLength(countAfterRun);
  });
});
