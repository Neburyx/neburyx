import { describe, expect, it } from 'vitest';
import { runChecks } from './runner.js';
import { execResult, fakeCheck, fakeExec, testContext } from './testing.js';

function deps(controller = new AbortController(), secrets: readonly string[] = [], dataSecrets: readonly string[] = secrets) {
  const logs = new Map<string, string>();
  let tick = 0;
  return {
    logs,
    value: {
      context: testContext(fakeExec(() => execResult()).exec, controller.signal),
      secrets,
      dataSecrets,
      monotonicNowMs: () => {
        tick += 10;
        return tick;
      },
      saveLog: (id: string, text: string) => {
        logs.set(id, text);
        return Promise.resolve(`logs/${id}.log`);
      },
    },
  };
}

describe('runChecks', () => {
  it('runs a check after one that failed, and lists both with their statuses', async () => {
    const { value } = deps();
    const results = await runChecks([fakeCheck('a', { status: 'failed', detail: 'exited with code 1', exitCode: 1 }), fakeCheck('b')], value);
    expect(results.map((result) => [result.id, result.status, result.exitCode])).toEqual([
      ['a', 'failed', 1],
      ['b', 'passed', 0],
    ]);
  });

  it('fails a check that throws, with its message, and goes on', async () => {
    const { value } = deps();
    const throwing = { ...fakeCheck('a'), run: () => Promise.reject(new Error('boom')) };
    const results = await runChecks([throwing, fakeCheck('b')], value);
    expect(results[0]).toMatchObject({ status: 'failed', detail: 'threw: boom', exitCode: null });
    expect(results[1]?.status).toBe('passed');
  });

  it('runs the checks one at a time, in the listed order', async () => {
    const { value } = deps();
    const order: string[] = [];
    const slow = (id: string) => ({
      ...fakeCheck(id),
      run: async () => {
        order.push(`start ${id}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(`end ${id}`);
        return { status: 'passed' as const, detail: 'ok', command: id, exitCode: 0, output: '' };
      },
    });
    await runChecks([slow('a'), slow('b')], value);
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b']);
  });

  it('records the duration of each check in milliseconds and names its log', async () => {
    const { value, logs } = deps();
    const results = await runChecks([fakeCheck('a')], value);
    expect(results[0]).toMatchObject({ durationMs: 10, log: 'logs/a.log' });
    expect(logs.get('a')).toBe('output of a');
  });

  it('marks the running check interrupted and the later ones not run after an interrupt', async () => {
    const controller = new AbortController();
    const { value } = deps(controller);
    const results = await runChecks([fakeCheck('a', {}, () => controller.abort()), fakeCheck('b'), fakeCheck('c')], value);
    expect(results.map((result) => [result.id, result.status, result.detail])).toEqual([
      ['a', 'failed', 'interrupted'],
      ['b', 'failed', 'not run: interrupted'],
      ['c', 'failed', 'not run: interrupted'],
    ]);
  });

  it('masks a secret in the log, the detail and the data', async () => {
    const { value, logs } = deps(new AbortController(), ['s3cret-pass']);
    const leaking = fakeCheck('a', { output: 'login s3cret-pass', detail: 'bad s3cret-pass', data: { uri: ['x s3cret-pass'] } });
    const results = await runChecks([leaking], value);
    expect(JSON.stringify(results)).not.toContain('s3cret-pass');
    expect(logs.get('a')).toBe('login ***');
  });
});
