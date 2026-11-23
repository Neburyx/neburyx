import { describe, expect, it } from 'vitest';
import { factsOf } from './facts.js';
import type { EnrichedRepeat } from './enrich.js';
import type { TurnRecords } from './records.js';

const call = (number: number, tokensIn: number | null = 100, tokensOut: number | null = 10) => ({ number, startedAt: '', durationMs: 1, status: 'answered', failureKind: null, errorClass: null, errorCode: null, tokensIn, tokensOut, instructionsSha256: 'sha-x', instructionsText: '', valuesText: '', replyText: null, toolsOffered: null });
const event = (action: string, cacheRead: number | 'unknown' | null = 1000, cacheWrite: number | 'unknown' | null = 200) => ({ action, result: 'success', sourceId: 'demo', tokensIn: null, tokensOut: null, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, modelCalls: null });
const records = (calls: number, over: Partial<TurnRecords> = {}): TurnRecords => ({ traceId: 't', run: { id: 'r', outcome: 'ok', finished: true, calls, settings: {} }, calls: Array.from({ length: calls }, (_, index) => call(index + 1)), events: [event('assistant.route'), ...Array.from({ length: calls - 1 }, () => event('assistant.agent'))], summaryCalls: 0, summaryUsage: [], reconciled: undefined, problems: [], ...over });
const repeat = (turns: { ms: number; records: TurnRecords | undefined }[]): EnrichedRepeat => ({ file: { manifest: { name: 'm', sha256: 'x' }, sourceId: 'demo', repeat: 1, expectedMessages: turns.map(() => 'q'), arm: 'a', head: 'h', settings: { model: 'm', callLimit: 7, configured: {} }, startedAt: '', endedAt: '', view: { entities: 26 }, turns: turns.map((turn, index) => ({ n: index + 1, message: 'q', traceId: `t${index}`, ms: turn.ms, httpStatus: 200, status: 'answered', answer: {} })), ended: 'complete' }, records: turns.map((turn) => turn.records), evidence: [], inconsistent: false, disagreeing: [] });
const PRICES = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, date: '2026-11-01' };

describe('the facts of a run', () => {
  it('marks a turn with no record, unknown usage or no prices incomplete, naming the cause, and never calls the figures evidence', () => {
    const facts = factsOf([repeat([{ ms: 1000, records: undefined }, { ms: 2000, records: records(3, { calls: [call(1), call(2, null), call(3)] }) }])], { callLimit: 7, prices: PRICES });
    expect(facts.incomplete).toContain('repeat 1 turn 1: no record');
    expect(facts.incomplete).toContain('repeat 1 turn 2: unknown token usage');
    expect(facts.evidence).toBe(false);
    const noPrices = factsOf([repeat([{ ms: 1, records: records(3) }])], { callLimit: 7 });
    expect(noPrices.incomplete).toContain('no prices given: tokens only, not accepted as evidence');
    expect(noPrices.evidence).toBe(false);
    expect(factsOf([repeat([{ ms: 1, records: records(3) }])], { callLimit: 7, prices: { ...PRICES, date: '' } }).incomplete).toContain('the prices carry no valid date: not accepted as evidence');
  });

  it('gives the mean, median and 95th percentile of calls per turn, the median time, the cost per turn and per run, and counts the calls of a summary', () => {
    const turns = [2, 3, 4, 4, 5, 5, 3, 4, 6, 3, 4, 2, 3, 4, 5, 4, 3, 4, 7, 4].map((calls, index) => ({ ms: 1000 + index, records: records(calls, index === 0 ? { summaryCalls: 1, summaryUsage: [{ number: 1, status: 'answered', tokensIn: 50, tokensOut: 5 }], events: [event('assistant.route'), event('assistant.agent'), event('ai.case-summary')] } : {}) }));
    const facts = factsOf([repeat(turns)], { callLimit: 7, prices: PRICES });
    expect(facts.turns[0]?.calls).toBe(3);
    expect(facts.turns[0]).toMatchObject({ inputTokens: 250, outputTokens: 25 });
    expect(facts.callsP95).toBe(6);
    expect(facts.callsMedian).toBe(4);
    expect(facts.incomplete).toEqual([]);
    expect(facts.medianMs).toBe(1009.5);
    expect(facts.turns[1]?.cost).toBeCloseTo((300 * 3 + 30 * 15 + 3000 * 0.3 + 600 * 3.75) / 1_000_000 * 1, 6);
    expect(facts.totalCost).toBeGreaterThan(0);
    expect(facts.evidence).toBe(true);
  });

  it('says whether the measured p95 is at or under the limit, lists the turns that used all of it by id, and states what a p95 under a cap cannot show', () => {
    const turns = [3, 4, 7, 5, 7].map((calls) => ({ ms: 10, records: records(calls) }));
    const facts = factsOf([repeat(turns)], { callLimit: 7, prices: PRICES });
    expect(facts.turnsAtLimit).toEqual(['repeat 1 turn 3', 'repeat 1 turn 5']);
    expect(facts.p95Verdict).toContain('at or under the call limit of 7');
    expect(facts.p95Verdict).toContain('cannot by itself show that 7 is enough');
    expect(factsOf([repeat([{ ms: 1, records: records(8) }])], { callLimit: 7 }).p95Verdict).toContain('over the call limit of 7');
  });

  it('takes the median of an even sample as the mean of the two middle values', () => {
    const facts = factsOf([repeat([2, 3, 5, 8].map((calls, index) => ({ ms: 10 * (index + 1), records: records(calls) })))], { callLimit: 7, prices: PRICES });
    expect(facts.callsMedian).toBe(4);
    expect(facts.medianMs).toBe(25);
  });

  it('accepts no evidence from nothing, an unfinished or inconsistent repeat, repeats of other shapes, a limit that is not the one run with, events that do not cover the calls or prices that are not valid', () => {
    expect(factsOf([], { callLimit: 7, prices: PRICES })).toMatchObject({ evidence: false, incomplete: expect.arrayContaining(['no repeat was given']) });
    const base = repeat([{ ms: 1, records: records(3) }]);
    const stopped = { ...base, file: { ...base.file, ended: 'failed' as const } };
    expect(factsOf([stopped], { callLimit: 7, prices: PRICES }).incomplete).toContain('repeat 1 ended as failed, not complete');
    expect(factsOf([{ ...base, inconsistent: true }], { callLimit: 7, prices: PRICES }).incomplete).toContain('repeat 1 ran with settings that differ from one turn to another');
    expect(factsOf([base], { callLimit: 5, prices: PRICES }).incomplete[0]).toContain('is not the limit the repeats ran with (7)');
    const other = repeat([{ ms: 1, records: records(3) }, { ms: 1, records: records(3) }]);
    expect(factsOf([base, other], { prices: PRICES }).incomplete).toContain('the repeats hold different numbers of turns (1, 2)');
    expect(factsOf([base], { prices: PRICES }).callLimit).toBe(7);
    const partial = factsOf([repeat([{ ms: 1, records: records(3, { events: [event('assistant.route')] }) }])], { callLimit: 7, prices: PRICES });
    expect(partial.incomplete).toContain('repeat 1 turn 1: the model events do not cover every call: no cache counts');
    expect(partial.evidence).toBe(false);
    for (const bad of [{ ...PRICES, input: -1 }, { ...PRICES, output: Number.NaN }, { ...PRICES, date: 'yesterday' }]) expect(factsOf([base], { callLimit: 7, prices: bad }).evidence).toBe(false);
  });

  it('accepts no evidence from a file that holds fewer turns than messages it was to send or other messages, reports the repeat by the number the file says, and refuses a date that is not on the calendar', () => {
    const base = repeat([{ ms: 1, records: records(3) }]);
    const short = { ...base, file: { ...base.file, repeat: 3, expectedMessages: Array.from({ length: 12 }, () => 'q') } };
    const facts = factsOf([short], { callLimit: 7, prices: PRICES });
    expect(facts.incomplete).toContain('repeat 3 holds 1 turns and was to send 12 messages');
    expect(facts.turns[0]?.repeat).toBe(3);
    expect(facts.evidence).toBe(false);
    const other = { ...base, file: { ...base.file, expectedMessages: ['another'] } };
    expect(factsOf([other], { callLimit: 7, prices: PRICES }).incomplete).toContain('repeat 1 turn 1 is not the message that was to be sent');
    for (const date of ['2026-02-31', '2026-13-01', '2026-1-1']) expect(factsOf([base], { callLimit: 7, prices: { ...PRICES, date } }).evidence).toBe(false);
    expect(factsOf([base], { callLimit: 7, prices: { ...PRICES, date: '2026-02-28' } }).evidence).toBe(true);
  });

  it('refuses the same run twice, runs of several arms and runs of different manifests, so that two copies of one repeat never look like a whole run', () => {
    const base = repeat([{ ms: 1, records: records(3) }]);
    expect(factsOf([base, base], { callLimit: 7, prices: PRICES }).incomplete).toContain('the run a/1 was given twice');
    const other = { ...base, file: { ...base.file, repeat: 2, arm: 'arm-b' } };
    expect(factsOf([base, other], { callLimit: 7, prices: PRICES }).incomplete).toContain('the runs are of several arms (a, arm-b)');
    const elsewhere = { ...base, file: { ...base.file, repeat: 2, manifest: { name: 'm', sha256: 'y' } } };
    expect(factsOf([base, elsewhere], { callLimit: 7, prices: PRICES }).incomplete).toContain('the runs were made from different manifests');
  });
});
