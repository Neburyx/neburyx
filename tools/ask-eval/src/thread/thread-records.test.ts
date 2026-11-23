import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../cli.js';
import type { EvalHooks } from '../hooks.js';
import type { RepeatFile } from './driver.js';
import { readTurnRecords, settingsDisagreements, type Db } from './records.js';

type Row = Record<string, unknown>;
interface World {
  runs: Record<string, Row[]>;
  calls: Record<string, Row[]>;
  events: Record<string, Row[]>;
  fail?: boolean;
}
/** A stand-in database that answers the three queries of the reader from a small world, and notes the text of every query. */
function dbOf(world: World, queries: string[] = []): Db {
  return {
    query: (text, values) => {
      queries.push(text);
      if (world.fail === true) return Promise.reject(new Error('connection refused postgres://user:SECRET@host/db'));
      if (text.includes('FROM assistant_runs')) return Promise.resolve({ rows: world.runs[String(values[0])] ?? [] });
      if (text.includes('FROM assistant_run_calls')) return Promise.resolve({ rows: ((values[0] as string[]) ?? []).flatMap((id) => world.calls[id] ?? []) });
      return Promise.resolve({ rows: world.events[String(values[0])] ?? [] });
    },
  };
}
const call = (number: number, over: Row = {}): Row => ({ call_number: number, started_at: new Date('2026-01-01T00:00:00Z'), duration_ms: 900, status: 'answered', failure_kind: null, error_class: null, error_code: null, tokens_in: 10, tokens_out: 5, values_text: `values ${number}`, reply_text: 'reply', ...over });
const world = (over: Partial<World> = {}): World => ({
  runs: { 'tr-1': [{ id: 'run-1', outcome: 'ok', calls: 3, settings: { model: 'model-a', maxCalls: 7 } }] },
  calls: { 'run-1': [call(1), call(2), call(3)] },
  events: {
    'tr-1': [
      { action: 'assistant.route', result: 'success', detail: { ai: { tokensIn: 10, tokensOut: 5, cacheReadTokens: 100, cacheWriteTokens: 'unknown' } } },
      { action: 'assistant.agent', result: 'success', detail: { ai: { tokensIn: 3, tokensOut: 2, cacheReadTokens: 0, cacheWriteTokens: 7 } } },
      { action: 'assistant.turn.closed', result: 'success', detail: { turn: { modelCalls: 3 } } },
    ],
  },
  ...over,
});

describe('the records of a turn', () => {
  it('stops with a named cause and no connection string when the database cannot be reached', async () => {
    await expect(readTurnRecords(dbOf(world({ fail: true })), 'tr-1')).rejects.toThrow();
    const dir = mkdtempSync(join(tmpdir(), 'thread-records-'));
    const run: RepeatFile = { manifest: { name: 'm', sha256: 'x' }, arm: 'refs', head: 'h', settings: { model: 'model-a', callLimit: 7 }, startedAt: '', endedAt: '', view: { entities: 26 }, turns: [{ n: 1, message: 'one', traceId: 'tr-1', ms: 1, httpStatus: 200, status: 'answered', answer: {} }], ended: 'complete' };
    writeFileSync(join(dir, 'run.json'), JSON.stringify(run));
    writeFileSync(join(dir, 'db.env'), 'NEBURYX_DEV_DATABASE_URL=postgres://u:SECRET@127.0.0.1/db\n');
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(['thread', 'records', '--file', join(dir, 'run.json'), '--database-env-file', join(dir, 'db.env'), '--out', join(dir, 'out.json')], { out: (line) => out.push(line), err: (line) => err.push(line), env: {} }, {} as unknown as EvalHooks, { database: () => Promise.reject(new Error('the database cannot be reached')) });
    expect(code).toBe(1);
    expect(JSON.stringify([out, err])).not.toContain('SECRET');
  });

  it('marks a turn with no run record and a call that was started and not ended, and never presents them as complete', async () => {
    const none = await readTurnRecords(dbOf(world()), 'tr-unknown');
    expect(none.problems).toEqual(['no run record for this trace id']);
    const queued = await readTurnRecords(dbOf(world({ calls: { 'run-1': [call(1), call(2, { status: null })] } })), 'tr-1');
    expect(queued.problems).toContain('call 2 was started and has no end in the record');
  });

  it('reads the run, the calls, the settings and the token counts of the model events, with the cache counts the call record does not hold', async () => {
    const records = await readTurnRecords(dbOf(world()), 'tr-1');
    expect(records.run).toEqual({ outcome: 'ok', calls: 3, settings: { model: 'model-a', maxCalls: 7 } });
    expect(records.calls.map((entry) => [entry.number, entry.tokensIn, entry.tokensOut, entry.durationMs])).toEqual([[1, 10, 5, 900], [2, 10, 5, 900], [3, 10, 5, 900]]);
    expect(records.events.find((event) => event.action === 'assistant.route')).toMatchObject({ cacheReadTokens: 100, cacheWriteTokens: 'unknown' });
    expect(records.problems).toEqual([]);
  });

  it('marks a repeat inconsistent when the settings of its turns disagree', async () => {
    const other = world({ runs: { 'tr-1': [{ id: 'run-1', outcome: 'ok', calls: 3, settings: { model: 'model-a', maxCalls: 7 } }], 'tr-2': [{ id: 'run-2', outcome: 'ok', calls: 1, settings: { model: 'model-a', maxCalls: 5 } }] }, calls: { 'run-1': [call(1)], 'run-2': [call(1)] }, events: {} });
    const one = await readTurnRecords(dbOf(other), 'tr-1');
    const two = await readTurnRecords(dbOf(other), 'tr-2');
    expect(settingsDisagreements([one, two])).toEqual(['tr-2']);
    expect(settingsDisagreements([one, one])).toEqual([]);
  });

  it('counts the calls of an AI case summary with the turn\'s calls and reconciles them with the closing event, and reports a difference', async () => {
    const withSummary = world({ events: { 'tr-1': [{ action: 'assistant.agent', result: 'success', detail: { ai: {} } }, { action: 'ai.case-summary', result: 'success', detail: { ai: {} } }, { action: 'ai.case-summary', result: 'success', detail: { ai: {} } }, { action: 'assistant.turn.closed', result: 'success', detail: { turn: { modelCalls: 5 } } }] } });
    const records = await readTurnRecords(dbOf(withSummary), 'tr-1');
    expect(records.summaryCalls).toBe(2);
    expect(records.reconciled).toEqual({ counted: 5, stated: 5, agree: true });
    const mismatch = await readTurnRecords(dbOf(world({ events: { 'tr-1': [{ action: 'assistant.turn.closed', result: 'success', detail: { turn: { modelCalls: 9 } } }] } })), 'tr-1');
    expect(mismatch.reconciled).toEqual({ counted: 3, stated: 9, agree: false });
    expect(mismatch.problems[0]).toContain('closing event states 9');
  });

  it('only reads: no query it makes writes, and the command writes the records beside the run file', async () => {
    const queries: string[] = [];
    await readTurnRecords(dbOf(world(), queries), 'tr-1');
    for (const text of queries) expect(text).toMatch(/^SELECT /u);
    const dir = mkdtempSync(join(tmpdir(), 'thread-records-'));
    const run: RepeatFile = { manifest: { name: 'm', sha256: 'x' }, arm: 'refs', head: 'h', settings: { model: 'model-a', callLimit: 7 }, startedAt: '', endedAt: '', view: { entities: 26 }, turns: [{ n: 1, message: 'one', traceId: 'tr-1', ms: 1, httpStatus: 200, status: 'answered', answer: {} }], ended: 'complete' };
    writeFileSync(join(dir, 'run.json'), JSON.stringify(run));
    const out: string[] = [];
    const code = await runCli(['thread', 'records', '--file', join(dir, 'run.json'), '--database-env-file', join(dir, 'unused.env'), '--out', join(dir, 'records.json')], { out: (line) => out.push(line), err: () => undefined, env: {} }, {} as unknown as EvalHooks, { database: () => Promise.resolve({ db: dbOf(world()), close: () => Promise.resolve() }) });
    expect(code).toBe(0);
    expect(out).toEqual(['turns read: 1 of 1']);
    expect((JSON.parse(readFileSync(join(dir, 'records.json'), 'utf8')) as { records: { calls: unknown[] }[] }).records[0]?.calls).toHaveLength(3);
  });
});
