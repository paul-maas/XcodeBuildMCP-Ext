import { describe, expect, it } from 'vitest';
import {
  isBuildErrorDiagnosticLine,
  parseBuildErrorDiagnostic,
  parseDurationMs,
  parseRawTestName,
} from '../xcodebuild-line-parsers.ts';

describe('parseDurationMs', () => {
  it('parses xcodebuild-style seconds text into milliseconds', () => {
    expect(parseDurationMs('0.002 seconds')).toBe(2);
    expect(parseDurationMs('1.234s')).toBe(1234);
  });

  it('returns undefined for unparseable duration text', () => {
    expect(parseDurationMs('unknown')).toBeUndefined();
    expect(parseDurationMs()).toBeUndefined();
  });
});

describe('parseBuildErrorDiagnostic', () => {
  it('preserves structureless diagnostic-looking error lines', () => {
    const line = 'Some build phase error: command failed with exit code 1';

    expect(parseBuildErrorDiagnostic(line)).toEqual({
      message: line,
      renderedLine: line,
    });
  });

  it('classifies real build errors with location and prefix forms', () => {
    expect(parseBuildErrorDiagnostic('/path/File.swift:42:10: error: cannot find type')).toEqual({
      location: '/path/File.swift:42',
      message: 'cannot find type',
      renderedLine: '/path/File.swift:42:10: error: cannot find type',
    });
    expect(parseBuildErrorDiagnostic('xcodebuild: error: Scheme not found')).toEqual({
      message: 'Scheme not found',
      renderedLine: 'xcodebuild: error: Scheme not found',
    });
  });

  it('treats os_log / runtime console lines as noise, not build errors', () => {
    // "<optional timestamp> Process[pid:tid] ... error: ..." is app/tool runtime logging,
    // not a build diagnostic, even when it contains "error:". These flooded
    // diagnostics.errors and bloated the tool response before being excluded.
    const appLog =
      '2026-04-28 18:18:28.585512+0300 SplitTunnelAlpha[82578:1256254] [HelperManager] XPC connection error: Could not connect';
    const xcodebuildLog = '2026-04-23 12:00:00.000 xcodebuild[123:456] error: IDE operation failed';
    const untimestamped = 'SplitTunnelAlpha[82578:1256254] some error: boom';

    for (const line of [appLog, xcodebuildLog, untimestamped]) {
      expect(isBuildErrorDiagnosticLine(line)).toBe(false);
      expect(parseBuildErrorDiagnostic(line)).toBeNull();
    }
  });
});

describe('parseRawTestName', () => {
  it('normalizes module-prefixed slash test names', () => {
    expect(
      parseRawTestName('CalculatorAppTests.CalculatorAppTests/testCalculatorServiceFailure'),
    ).toEqual({
      suiteName: 'CalculatorAppTests',
      testName: 'testCalculatorServiceFailure',
    });
  });

  it('normalizes module-prefixed objective-c style test names', () => {
    expect(parseRawTestName('-[CalculatorAppTests.IntentionalFailureTests test]')).toEqual({
      suiteName: 'IntentionalFailureTests',
      testName: 'test',
    });
  });

  it('keeps multi-segment slash suite names for swift-testing output', () => {
    expect(parseRawTestName('TestLibTests/IntentionalFailureSuite/test')).toEqual({
      suiteName: 'TestLibTests/IntentionalFailureSuite',
      testName: 'test',
    });
  });
});
