// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SOURCE_READS_IN_A_ROW, SOURCE_REQUEST_DEADLINE_MS } from '@neburyx/contracts';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiResult } from './client.js';
import { AGGREGATE_EVIDENCE_WAIT_MS, AGGREGATE_REFS_WAIT_MS, boundedRead, DERIVED_ROWS_WAIT_MS, READ_WAIT_MS, SEARCH_MORE_WAIT_MS, SEARCH_WAIT_MS, TYPEAHEAD_WAIT_MS } from './read-wait.js';

const answer: ApiResult<number> = { ok: true, value: 1 };

/** A read that never answers by itself, with the signal it was given and the way to answer it late. */
function hung() {
  let signal: AbortSignal | undefined;
  let settle: (result: ApiResult<number>) => void = () => undefined;
  return {
    load: (given: AbortSignal) => {
      signal = given;
      return new Promise<ApiResult<number>>((resolve) => {
        settle = resolve;
      });
    },
    aborted: () => signal?.aborted,
    settle: (result: ApiResult<number>) => settle(result),
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('a read that may not wait without end', () => {
  it('is given up after the wait as a server that did not answer, and its request is aborted', async () => {
    const read = hung();
    let result: ApiResult<number> | undefined;
    void boundedRead(read.load).then((got) => (result = got));
    await vi.advanceTimersByTimeAsync(READ_WAIT_MS - 1);
    expect(result).toBeUndefined();
    expect(read.aborted()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toEqual({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } });
    expect(read.aborted()).toBe(true);
  });

  it('drops an answer that comes after it was given up', async () => {
    const read = hung();
    const results: ApiResult<number>[] = [];
    void boundedRead(read.load).then((got) => results.push(got));
    await vi.advanceTimersByTimeAsync(READ_WAIT_MS);
    read.settle(answer);
    await vi.advanceTimersByTimeAsync(0);
    expect(results).toEqual([{ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }]);
  });

  it('answers what the server answered in time, and leaves no timer behind', async () => {
    await expect(boundedRead(() => Promise.resolve(answer))).resolves.toBe(answer);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stays an abort when the caller aborts it, and leaves no timer behind', async () => {
    const read = hung();
    const caller = new AbortController();
    const result = boundedRead(read.load, caller.signal);
    caller.abort();
    await expect(result).resolves.toEqual({ ok: false, failure: { code: 'ABORTED' } });
    expect(read.aborted()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is an abort at once, with no request made, when the caller aborted before it began', async () => {
    const load = vi.fn(() => Promise.resolve(answer));
    const caller = new AbortController();
    caller.abort();
    await expect(boundedRead(load, caller.signal)).resolves.toEqual({ ok: false, failure: { code: 'ABORTED' } });
    expect(load).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('passes on a request that threw before it returned, and leaves no timer behind', async () => {
    const thrower = (): Promise<ApiResult<number>> => {
      throw new Error('broke at once');
    };
    await expect(boundedRead(thrower)).rejects.toThrow('broke at once');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('passes on a request that threw', async () => {
    await expect(boundedRead(() => Promise.reject(new Error('broke')))).rejects.toThrow('broke');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits the longer time it is given, so that an answer after the usual wait is still taken', async () => {
    const read = hung();
    const result = boundedRead(read.load, undefined, SEARCH_WAIT_MS);
    await vi.advanceTimersByTimeAsync(READ_WAIT_MS + 1);
    read.settle(answer);
    await expect(result).resolves.toBe(answer);
  });
});

describe('the waits of the reads that read a source several times in a row', () => {
  it.each([
    ['search', SEARCH_WAIT_MS, SOURCE_READS_IN_A_ROW.search, 45_000],
    ['search more', SEARCH_MORE_WAIT_MS, SOURCE_READS_IN_A_ROW.searchMore, 35_000],
    ['type-ahead', TYPEAHEAD_WAIT_MS, SOURCE_READS_IN_A_ROW.typeahead, 35_000],
    ['derived rows', DERIVED_ROWS_WAIT_MS, SOURCE_READS_IN_A_ROW.derivedRows, 25_000],
    ['aggregate evidence', AGGREGATE_EVIDENCE_WAIT_MS, SOURCE_READS_IN_A_ROW.aggregateEvidence, 25_000],
    ['aggregate references', AGGREGATE_REFS_WAIT_MS, SOURCE_READS_IN_A_ROW.aggregateRefs, 25_000],
  ])('is longer for %s than every deadline of the server in a row', (_name, wait, reads, expected) => {
    expect(wait).toBe(expected);
    expect(wait).toBeGreaterThan(reads * SOURCE_REQUEST_DEADLINE_MS);
  });

  it('keeps the usual wait longer than one read of a source', () => {
    expect(READ_WAIT_MS).toBeGreaterThan(SOURCE_REQUEST_DEADLINE_MS);
  });
});

const READ_WAIT = /\b(READ|SEARCH|SEARCH_MORE|TYPEAHEAD|DERIVED_ROWS|AGGREGATE_EVIDENCE|AGGREGATE_REFS)_WAIT_MS\b/;

/** Whether a file starts a timer whose time is a wait of a read: a second way to give a read up. */
function timesAWait(source: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && /(^|\.)(setTimeout|timeout)$/.test(node.expression.getText()) && READ_WAIT.test(node.arguments.at(-1)?.getText() ?? '')) found = true;
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile('file.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX));
  return found;
}

describe('the one wait of the web client', () => {
  it('is timed in one place: no other product file starts a timer with a wait of a read', () => {
    const root = join(import.meta.dirname, '..');
    const own = join('api', 'read-wait.ts');
    const timed = readdirSync(root, { recursive: true, encoding: 'utf8' })
      .filter((path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path) && path !== own)
      .filter((path) => timesAWait(readFileSync(join(root, path), 'utf8')));
    expect(timed).toEqual([]);
  });

  it('would find a second one, and leaves a timer of another kind alone', () => {
    expect(timesAWait('const t = window.setTimeout(giveUp, READ_WAIT_MS);')).toBe(true);
    expect(timesAWait('const s = AbortSignal.timeout(SEARCH_WAIT_MS);')).toBe(true);
    expect(timesAWait('setTimeout(() => boundedRead(load, undefined, SEARCH_WAIT_MS), DEBOUNCE_MS);')).toBe(false);
  });
});
