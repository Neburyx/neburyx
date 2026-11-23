import { describe, expect, it } from 'vitest';
import { factsOf } from './facts.js';
import type { EnrichedRepeat } from './enrich.js';
import type { TurnRecords } from './records.js';

const call = (number: number, tokensIn: number | null = 100, tokensOut: number | null = 10) => ({ number, startedAt: '', durationMs: 1, status: 'answered', failureKind: null, errorClass: null, errorCode: null, tokensIn, tokensOut, valuesText: '', replyText: null, toolsOffered: null });
const event = (action: string, cacheRead: number | 'unknown' | null = 1000, cacheWrite: number | 'unknown' | null = 200) => ({ action, result: 'success', tokensIn: null, tokensOut: null, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, modelCalls: null });
const records = (calls: number, over: Partial<TurnRecords> = {}): TurnRecords => ({ traceId: 't', run: { outcome: 'ok', calls, settings: {} }, calls: Array.from({ length: calls }, (_, index) => call(index + 1)), events: [event('assistant.route'), ...Array.from({ length: calls - 1 }, () => event('assistant.agent'))], summaryCalls: 0, reconciled: undefined, problems: [], ...over });
const repeat = (turns: { ms: number; records: TurnRecords | undefined }[]): EnrichedRepeat => ({ file: { manifest: { name: 'm', sha256: 'x' }, arm: 'a', head: 'h', settings: { model: 'm', callLimit: 7 }, startedAt: '', endedAt: '', view: { entities: 26 }, turns: turns.map((turn, index) => ({ n: index + 1, message: 'q', traceId: `t${index}`, ms: turn.ms, httpStatus: 200, status: 'answered', answer: {} })), ended: 'complete' }, records: turns.map((turn) => turn.records), inconsistent: false, disagreeing: [] });
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
    expect(factsOf([repeat([{ ms: 1, records: records(3) }])], { callLimit: 7, prices: { ...PRICES, date: '' } }).incomplete).toContain('the prices carry no date: not accepted as evidence');
  });

  it('gives the mean, median and 95th percentile of calls per turn, the median time, the cost per turn and per run, and counts the calls of a summary', () => {
    const turns = [2, 3, 4, 4, 5, 5, 3, 4, 6, 3, 4, 2, 3, 4, 5, 4, 3, 4, 7, 4].map((calls, index) => ({ ms: 1000 + index, records: records(calls, index === 0 ? { summaryCalls: 1 } : {}) }));
    const facts = factsOf([repeat(turns)], { callLimit: 7, prices: PRICES });
    expect(facts.turns[0]?.calls).toBe(3);
    expect(facts.callsP95).toBe(6);
    expect(facts.callsMedian).toBe(4);
    expect(facts.medianMs).toBe(1009);
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
});
