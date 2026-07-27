import { execFileSync } from 'node:child_process';
import { log } from './logger.ts';
import type { TestFailureFragment } from '../types/domain-fragments.ts';
import { parseRawTestName } from './xcodebuild-line-parsers.ts';

interface XcresultTestNode {
  name: string;
  nodeType: string;
  result?: string;
  children?: XcresultTestNode[];
}

interface XcresultTestResults {
  testNodes: XcresultTestNode[];
}

/** Authoritative per-test-case tallies read from the `.xcresult` bundle. */
export interface XcresultTestCounts {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
}

export interface XcresultTestResultsExtract {
  failures: TestFailureFragment[];
  /** null when the bundle could not be queried or contained no test cases. */
  counts: XcresultTestCounts | null;
}

/**
 * Extracts both the failure diagnostics and the pass/fail/skip tallies from an
 * `.xcresult` bundle in a single `xcresulttool` invocation and a single tree
 * walk. This is the authoritative source for test counts: stdout scraping
 * under-counts parallel / multi-suite runs (it combines per-suite summary lines
 * with `Math.max` rather than summing), whereas the bundle records every test
 * case exactly once with its own `result`.
 */
export function extractTestResultsFromXcresult(xcresultPath: string): XcresultTestResultsExtract {
  try {
    const output = execFileSync(
      'xcrun',
      ['xcresulttool', 'get', 'test-results', 'tests', '--path', xcresultPath],
      { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    const results: XcresultTestResults = JSON.parse(output);
    const fragments: TestFailureFragment[] = [];
    let passed = 0;
    let failed = 0;
    let skipped = 0;

    function walk(node: XcresultTestNode, suiteContext?: string): void {
      const parsedNodeName = parseRawTestName(node.name);
      const nextSuiteContext =
        node.nodeType === 'Test Case'
          ? suiteContext
          : (parsedNodeName.suiteName ??
            (node.nodeType === 'Test Suite' ? node.name.replaceAll('_', ' ') : suiteContext));

      if (node.nodeType === 'Test Case') {
        // Count each test case exactly once. "Expected Failure" is a green
        // outcome (XCTExpectFailure), so it tallies as passed; an unknown or
        // absent result is left uncounted rather than invented as a pass.
        switch (node.result) {
          case 'Failed':
            failed += 1;
            break;
          case 'Skipped':
            skipped += 1;
            break;
          case 'Passed':
          case 'Expected Failure':
            passed += 1;
            break;
          default:
            break;
        }

        if (node.result === 'Failed' && node.children) {
          for (const child of node.children) {
            if (child.nodeType === 'Failure Message') {
              const parsed = parseFailureMessage(child.name);
              const { suiteName, testName } = parsedNodeName;
              fragments.push({
                kind: 'test-result',
                fragment: 'test-failure',
                operation: 'TEST',
                suite: suiteName ?? suiteContext,
                test: testName,
                message: parsed.message,
                location: parsed.location,
              });
            }
          }
        }
      }

      if (node.children) {
        for (const child of node.children) {
          walk(child, nextSuiteContext);
        }
      }
    }

    for (const root of results.testNodes) {
      walk(root);
    }

    const total = passed + failed + skipped;
    return {
      failures: fragments,
      counts: total > 0 ? { passed, failed, skipped, total } : null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log('debug', `Failed to extract test results from xcresult: ${message}`);
    return { failures: [], counts: null };
  }
}

/** Failures-only convenience wrapper retained for callers that do not need counts. */
export function extractTestFailuresFromXcresult(xcresultPath: string): TestFailureFragment[] {
  return extractTestResultsFromXcresult(xcresultPath).failures;
}

function parseFailureMessage(raw: string): { message: string; location?: string } {
  const match = raw.match(/^(.+?):(\d+): (.+)$/);
  if (match) {
    return {
      location: match[2] === '0' ? undefined : `${match[1]}:${match[2]}`,
      message: match[3].replace(/^failed\s*-\s*/u, ''),
    };
  }
  return { message: raw };
}
