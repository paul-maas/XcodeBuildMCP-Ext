import { describe, expect, it } from 'vitest';
import { createBuildDomainResult, createTestDomainResult } from '../xcodebuild-domain-results.ts';
import { createXcodebuildRunState, type XcodebuildRunState } from '../xcodebuild-run-state.ts';
import type { StartedPipeline, XcodebuildPipeline } from '../xcodebuild-pipeline.ts';
import type { TestPreflightResult } from '../test-preflight.ts';

function createStartedPipelineWithState(state: XcodebuildRunState): StartedPipeline {
  const pipeline: XcodebuildPipeline = {
    onStdout(): void {},
    onStderr(): void {},
    emitFragment(): void {},
    finalize() {
      return { state };
    },
    highestStageRank() {
      return 0;
    },
    xcresultPath: null,
    logPath: '/tmp/build.log',
  };

  return { pipeline, startedAt: Date.now() };
}

describe('xcodebuild-domain-results', () => {
  it('does not duplicate fallback lines represented by multi-line parsed errors', () => {
    const runState = createXcodebuildRunState({ operation: 'BUILD' });
    runState.push({
      kind: 'build-result',
      fragment: 'compiler-diagnostic',
      operation: 'BUILD',
      severity: 'error',
      message:
        'Unable to find a device matching the provided destination specifier:\n{ platform:iOS Simulator, name:iPhone 22, OS:latest }',
      rawLine:
        'xcodebuild: error: Unable to find a device matching the provided destination specifier:\n\t\t{ platform:iOS Simulator, name:iPhone 22, OS:latest }',
    });

    const result = createBuildDomainResult({
      started: createStartedPipelineWithState(runState.finalize(false, 1000)),
      succeeded: false,
      target: 'simulator',
      artifacts: { buildLogPath: '/tmp/build.log' },
      request: { scheme: 'App' },
      fallbackErrorMessages: [
        'xcodebuild: error: Unable to find a device matching the provided destination specifier:',
        '\t\t{ platform:iOS Simulator, name:iPhone 22, OS:latest }',
      ],
    });

    if (!result.diagnostics) {
      throw new Error('Expected diagnostics to be present');
    }

    expect(result.diagnostics.rawOutput).toBeUndefined();
  });

  it('preserves diagnostic-looking fallback lines not represented by parsed errors', () => {
    const runState = createXcodebuildRunState({ operation: 'BUILD' });
    runState.push({
      kind: 'build-result',
      fragment: 'compiler-diagnostic',
      operation: 'BUILD',
      severity: 'error',
      location: '/tmp/App.swift:8',
      message: 'type mismatch',
      rawLine: '/tmp/App.swift:8:17: error: type mismatch',
    });
    const parsedLine = '/tmp/App.swift:8:17: error: type mismatch';
    const unparsedLine = '2026-04-23 12:00:00.000 xcodebuild[123:456] error: IDE operation failed';

    const result = createBuildDomainResult({
      started: createStartedPipelineWithState(runState.finalize(false, 1000)),
      succeeded: false,
      target: 'simulator',
      artifacts: { buildLogPath: '/tmp/build.log' },
      request: { scheme: 'App' },
      fallbackErrorMessages: [parsedLine, unparsedLine, 'ordinary progress line'],
    });

    expect(result.diagnostics).toMatchObject({
      errors: [{ location: '/tmp/App.swift:8', message: 'type mismatch' }],
      rawOutput: [unparsedLine],
    });
  });

  it('caps tests.selected while preserving the full count in discovered.total', () => {
    const testCount = 150;
    const tests = Array.from({ length: testCount }, (_, i) => {
      const suffix = String(i).padStart(3, '0');
      return {
        framework: 'xctest' as const,
        targetName: 'AppTests',
        typeName: 'SuiteA',
        methodName: `test_${suffix}`,
        displayName: `AppTests/SuiteA/test_${suffix}`,
        line: i + 1,
        parameterized: false,
      };
    });

    const preflight: TestPreflightResult = {
      scheme: 'App',
      configuration: 'Debug',
      destinationName: 'macOS',
      selectors: {
        onlyTesting: [{ raw: 'AppTests', target: 'AppTests' }],
        skipTesting: [],
      },
      targets: [
        { name: 'AppTests', files: [{ path: '/tmp/AppTests.swift', tests }], warnings: [] },
      ],
      warnings: [],
      totalTests: testCount,
      completeness: 'complete',
    };

    const runState = createXcodebuildRunState({ operation: 'TEST' });
    const result = createTestDomainResult({
      started: createStartedPipelineWithState(runState.finalize(true, 1000)),
      succeeded: true,
      target: 'macos',
      artifacts: { buildLogPath: '/tmp/build.log' },
      request: { scheme: 'App' },
      preflight,
    });

    // selected is capped to MAX_SELECTED_TESTS (100) to bound structuredContent size,
    // while the true total remains available via discovered.total.
    expect(result.tests?.selected).toHaveLength(100);
    expect(result.tests?.discovered?.total).toBe(testCount);
    expect(result.tests?.discovered?.items).toHaveLength(6);
  });
});
