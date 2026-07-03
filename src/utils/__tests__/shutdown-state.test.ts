import { afterEach, describe, expect, it } from 'vitest';
import {
  areProcessStdioWritesSuppressed,
  resetShutdownStateForTests,
  suppressProcessStdioWrites,
} from '../shutdown-state.ts';

afterEach(() => {
  resetShutdownStateForTests();
});

describe('shutdown-state', () => {
  it('suppresses stdio writes idempotently', () => {
    expect(areProcessStdioWritesSuppressed()).toBe(false);
    suppressProcessStdioWrites();
    suppressProcessStdioWrites();
    expect(areProcessStdioWritesSuppressed()).toBe(true);
  });
});
