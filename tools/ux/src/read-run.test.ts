import { describe, expect, it } from 'vitest';
import { readRun } from './mutate.ts';

const report = (extra: object = {}) => JSON.stringify({ stats: { expected: 1, unexpected: 0, flaky: 0 }, suites: [{ specs: [{ title: 't', tests: [{ results: [{ status: 'passed' }] }] }] }], ...extra });

describe('the reading of a test run', () => {
  it('counts a passing run as one test passed with nothing wrong', () => {
    expect(readRun(report(), 0)).toEqual({ failures: [], errors: [], passed: 1 });
  });

  it('keeps the message of a failed test, without colour', () => {
    const failed = JSON.stringify({ stats: { expected: 0, unexpected: 1 }, suites: [{ specs: [{ title: 'the test', tests: [{ results: [{ status: 'failed', error: { message: '\u001b[31mexpect(received).toBe(expected)\u001b[39m' } }] }] }] }] });
    expect(readRun(failed, 1)).toMatchObject({ failures: [{ title: 'the test', message: 'expect(received).toBe(expected)' }] });
  });

  it('keeps an error of the runner beside tests that passed, a process that ended badly with nothing failed, and no report at all', () => {
    expect(readRun(report({ errors: [{ message: 'the global teardown threw\nstack' }] }), 1).errors).toEqual(['the global teardown threw']);
    expect(readRun(report(), 1).errors).toHaveLength(1);
    expect(readRun('', 1)).toMatchObject({ passed: 0, errors: [expect.stringContaining('no report')] });
  });

  it('is not a clean pass when a test passed only on a retry', () => {
    expect(readRun(report({ stats: { expected: 1, flaky: 1 } }), 0).errors).toEqual(['a test passed only on a retry']);
  });
});
