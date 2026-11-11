import { describe, expect, it } from 'vitest';
import { commandCheck } from './command-check.js';
import { execResult, fakeExec, testContext } from './testing.js';

const vitestOutput = (tests: string): string => ` Test Files  2 passed (2)\n      Tests  ${tests}\n`;

function check(answers: Parameters<typeof fakeExec>[0], expectsTests = true) {
  const fake = fakeExec(answers);
  const instance = commandCheck({ id: 'x', name: 'X', requests: [{ command: 'prep', args: [] }, { command: 'tests', args: ['--run'], timeoutMs: 1000 }], expectsTests });
  return { fake, run: () => instance.run(testContext(fake.exec)) };
}

describe('commandCheck', () => {
  it('fails a program that cannot be started, with the reason, and runs no later request', async () => {
    const { fake, run } = check(() => execResult({ exitCode: null, startError: 'spawn prep ENOENT' }));
    expect(await run()).toMatchObject({ status: 'failed', detail: 'could not start: spawn prep ENOENT' });
    expect(fake.requests).toHaveLength(1);
  });

  it('fails a request that runs past its timeout and says how long it was allowed', async () => {
    const { run } = check((request) => (request.command === 'tests' ? execResult({ exitCode: null, timedOut: true }) : execResult()));
    expect(await run()).toMatchObject({ status: 'failed', detail: 'timed out after 1000 ms', exitCode: null });
  });

  it('fails a non-zero exit with its code', async () => {
    const { run } = check((request) => (request.command === 'tests' ? execResult({ exitCode: 3 }) : execResult()));
    expect(await run()).toMatchObject({ status: 'failed', detail: 'exited with code 3', exitCode: 3 });
  });

  it('fails a test run that exits 0 and shows no passed test', async () => {
    const { run } = check(() => execResult({ output: 'No test files found\n' }));
    expect(await run()).toMatchObject({ status: 'failed', detail: 'no tests ran' });
  });

  it('fails a test run whose summary says zero passed', async () => {
    const { run } = check(() => execResult({ output: vitestOutput('0 passed (0)') }));
    expect(await run()).toMatchObject({ status: 'failed', detail: 'no tests ran' });
  });

  it('passes a test run with passed tests and counts them', async () => {
    const { run } = check(() => execResult({ output: vitestOutput('12 passed (12)') }));
    expect(await run()).toMatchObject({ status: 'passed', detail: '12 tests passed' });
  });

  it('counts the passed tests of a run that also has failures only when it exits 0', async () => {
    const { run } = check(() => execResult({ output: vitestOutput('1 failed | 4 passed (5)') }));
    expect((await run()).status).toBe('passed');
  });

  it('passes a request that is not a test run on exit 0 alone', async () => {
    const { run } = check(() => execResult(), false);
    expect(await run()).toMatchObject({ status: 'passed', detail: 'exit 0' });
  });
});
