import type { SourcesResponse, SourceTestReport } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import type { ApiResult } from '../api/client.js';
import { fakeClient } from '../api/fake-client.js';
import { createShellData } from '../shell/shell-data.js';
import { me, source, testReport } from '../test-utils.js';
import { createTestRuns } from './test-runs.js';

function deferred<T>() {
  let settle: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    settle = done;
  });
  return { promise, resolve: (value: T) => settle(value) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

type Sources = ApiResult<SourcesResponse>;

const listed: Sources = { ok: true, value: { items: [source('a'), source('b')], nextCursor: null } };
const never = () => new Promise<Sources>(() => undefined);

/** `reads` answers the sources reads in turn; the last one answers every read after it. */
function setup(testSource: (sourceId: string) => Promise<ApiResult<SourceTestReport>>, reads: Array<() => Promise<Sources>> = [async () => listed]) {
  const calls: { tests: string[]; sources: number } = { tests: [], sources: 0 };
  const client = fakeClient({
    getMe: async () => ({ ok: true, value: me() }),
    getSources: () => {
      const read = reads[Math.min(calls.sources, reads.length - 1)] ?? (async () => listed);
      calls.sources += 1;
      return read();
    },
    testSource: (sourceId) => {
      calls.tests.push(sourceId);
      return testSource(sourceId);
    },
  });
  const shell = createShellData(client);
  return { runs: createTestRuns(client, shell), shell, calls };
}

const ok = (report: SourceTestReport): ApiResult<SourceTestReport> => ({ ok: true, value: report });

describe('the runs of tests', () => {
  it('sends one request however often a run is started while it is going, and shows it running', async () => {
    const answer = deferred<ApiResult<SourceTestReport>>();
    const { runs, calls } = setup(() => answer.promise);
    await settle();
    runs.start('a');
    runs.start('a');
    expect(calls.tests).toEqual(['a']);
    expect(runs.getState().get('a')?.running).toBe(true);
    answer.resolve(ok(testReport('a')));
    await settle();
    expect(runs.getState().get('a')?.running).toBe(false);
  });

  it('holds the report of a source, announces its state and asks the shell for the sources once', async () => {
    const { runs, calls } = setup(async (id) => ok(testReport(id, { state: 'degraded', outcome: 'warn' })), [async () => listed, never]);
    await settle();
    expect(calls.sources).toBe(1);
    runs.start('a');
    await settle();
    expect(runs.getState().get('a')).toMatchObject({ running: false, finishedState: 'degraded', held: { outcome: 'warn', checkedAt: '2026-11-02T10:00:00.000Z' } });
    expect(calls.sources).toBe(2);
  });

  it('keeps the answers of two sources apart whichever arrives first', async () => {
    const first = deferred<ApiResult<SourceTestReport>>();
    const second = deferred<ApiResult<SourceTestReport>>();
    const { runs } = setup((id) => (id === 'a' ? first.promise : second.promise), [async () => listed, never]);
    await settle();
    runs.start('a');
    runs.start('b');
    second.resolve(ok(testReport('b', { checkedAt: '2026-11-02T10:05:00.000Z' })));
    await settle();
    expect(runs.getState().get('a')?.running).toBe(true);
    expect(runs.getState().get('b')?.held?.checkedAt).toBe('2026-11-02T10:05:00.000Z');
    first.resolve(ok(testReport('a', { checkedAt: '2026-11-02T10:01:00.000Z' })));
    await settle();
    expect(runs.getState().get('a')?.held?.checkedAt).toBe('2026-11-02T10:01:00.000Z');
    expect(runs.getState().get('b')?.held?.checkedAt).toBe('2026-11-02T10:05:00.000Z');
  });

  it('keeps the failure, not running, and the report held before, and clears the failure when a run starts again', async () => {
    let attempt = 0;
    const { runs } = setup(async (id) => {
      attempt += 1;
      return attempt === 2 ? { ok: false, failure: { code: 'SOURCE_BUSY', message: 'busy', retryable: true, traceId: 't' } } : ok(testReport(id));
    }, [async () => listed, never]);
    await settle();
    runs.start('a');
    await settle();
    runs.start('a');
    await settle();
    expect(runs.getState().get('a')).toMatchObject({ running: false, failure: { code: 'SOURCE_BUSY' }, held: { outcome: 'pass' } });
    runs.start('a');
    expect(runs.getState().get('a')?.failure).toBeUndefined();
    await settle();
    expect(runs.getState().get('a')?.failure).toBeUndefined();
  });

  it('gives an unexpected failure when the client throws', async () => {
    const { runs } = setup(() => Promise.reject(new Error('boom')));
    await settle();
    runs.start('a');
    await settle();
    expect(runs.getState().get('a')).toMatchObject({ running: false, failure: { code: 'UNEXPECTED_FAILURE' } });
  });

  it('drops the held reports when a later sources answer arrives, which the server made after storing the test', async () => {
    const answer = deferred<Sources>();
    const { runs } = setup(async (id) => ok(testReport(id)), [async () => listed, () => answer.promise]);
    await settle();
    runs.start('a');
    await settle();
    expect(runs.getState().get('a')?.held).toBeDefined();
    answer.resolve({ ok: true, value: { items: [source('a'), source('b')], nextCursor: null } });
    await settle();
    expect(runs.getState().get('a')?.held).toBeUndefined();
    expect(runs.getState().get('a')?.finishedState).toBe('connected');
  });

  it('keeps the held report when the sources read that follows has failed', async () => {
    const failed = async (): Promise<Sources> => ({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } });
    const { runs, calls } = setup(async (id) => ok(testReport(id)), [async () => listed, failed]);
    await settle();
    runs.start('a');
    await settle();
    expect(calls.sources).toBe(2);
    expect(runs.getState().get('a')?.held?.outcome).toBe('pass');
  });
});
