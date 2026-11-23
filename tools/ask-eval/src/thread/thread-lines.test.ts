import { describe, expect, it } from 'vitest';
import { gateEvidenceOf } from './gate-evidence.js';
import { citedLinesOf, linesOfAnswer } from './lines.js';
import type { TurnRecords } from './records.js';

const call = (number: number, over: Record<string, unknown> = {}) => ({ number, startedAt: '', durationMs: 1, status: 'answered', failureKind: null, errorClass: null, errorCode: null, tokensIn: 1, tokensOut: 1, valuesText: '', replyText: null as string | null, toolsOffered: null as readonly string[] | null, ...over });
const records = (over: Partial<TurnRecords> = {}): TurnRecords => ({ traceId: 'tr-1', run: { outcome: 'ok', calls: 3, settings: {} }, calls: [], events: [], summaryCalls: 0, reconciled: undefined, problems: [], ...over });

const FIRST = 'human: Question:\nhow many?\nai: [{"type":"tool_use","id":"t1","name":"view","input":{}}] [{"name":"view","args":{}}]\ntool: Keys are renumbered after every read: cite only keys of the latest result.\nn1 | "account" | title: "Account W-1" | id: "W-1"\n';
const SECOND = `${FIRST}ai: [{"type":"tool_use","id":"t2","name":"degree-preview","input":{}}] [{"name":"degree-preview","args":{}}]\ntool: Keys are renumbered after every read: cite only keys of the latest result.\nn1 | "account" | title: "Account W-1" | id: "W-1"\ns1: read of degree-preview: 6 shown · all types 184,533 (exact)`;
const ANSWER_REPLY = '[{"type":"tool_use","id":"t3","name":"answer","input":{"sentences":[{"text":"x","cites":["n1","s1"]}]}}]';

describe('the lines an answer cites', () => {
  it('marks a cited key for which no line was found, and invents none; no answer call gives no lines', () => {
    const lines = linesOfAnswer(records({ calls: [call(2, { valuesText: SECOND, replyText: ANSWER_REPLY })] }));
    const cited = citedLinesOf({ sentences: [{ text: 'x', cites: ['n1', 's9'] }] }, lines);
    expect(cited.missing).toEqual(['s9']);
    expect([...cited.mapped.keys()]).toEqual(['n1']);
    expect(linesOfAnswer(records({ calls: [call(1, { valuesText: FIRST, replyText: 'no answer here' })] }))).toBeUndefined();
    expect(citedLinesOf({ sentences: [{ text: 'x', cites: ['n1'] }] }, undefined).missing).toEqual(['n1']);
  });

  it('parses the element lines and the read lines the model was shown in the call that wrote the answer, taking the latest result when the keys were renumbered', () => {
    const lines = linesOfAnswer(records({ calls: [call(1, { valuesText: FIRST, replyText: '[{"type":"tool_use","id":"t1","name":"view","input":{}}]' }), call(2, { valuesText: SECOND, replyText: ANSWER_REPLY })] }));
    expect(lines?.callNumber).toBe(2);
    expect(lines?.lines.get('s1')).toBe('s1: read of degree-preview: 6 shown · all types 184,533 (exact)');
    expect(lines?.lines.get('n1')).toContain('Account W-1');
    const cited = citedLinesOf({ sentences: [{ text: 'x', cites: ['n1', 's1'] }] }, lines);
    expect(cited.missing).toEqual([]);
    expect([...cited.mapped.keys()]).toEqual(['n1', 's1']);
  });

  it('reads the lines of a table answer from the cites of its rows, and the formats of the first blind sets of the trial (read lines `s1:` and `r1:`)', () => {
    const values = 'human: Question:\nq\ntool: Keys are renumbered.\nr1: transaction: TX-1\nr2: transaction: TX-2\ns1: read of expand: 25 matches shown · lower bound';
    const lines = linesOfAnswer(records({ calls: [call(2, { valuesText: values, replyText: ANSWER_REPLY })] }));
    const cited = citedLinesOf({ table: { rows: [{ cells: ['TX-1'], cites: ['r1'] }, { cells: ['TX-2'], cites: ['r2', 's1'] }] } }, lines);
    expect(cited.missing).toEqual([]);
    expect([...cited.mapped.keys()]).toEqual(['r1', 'r2', 's1']);
  });
});

describe('the evidence for the gate and the tools', () => {
  const ALLOWED = ['view', 'degree-preview', 'answer'];
  const agent = (over: Record<string, unknown> = {}) => call(2, { replyText: '[{"type":"tool_use","id":"t","name":"view","input":{}}]', toolsOffered: ['answer', 'degree-preview', 'view'], ...over });

  it('reports a piece that cannot be established as unverified, never as passed: no stored tool names, no run record', () => {
    const noNames = gateEvidenceOf(records({ calls: [call(1), agent({ toolsOffered: null })] }), 1, ALLOWED);
    expect(noNames.offered.verdict).toBe('unverified');
    expect(noNames.offered.callsWithoutNames).toBe(1);
    const noRun = gateEvidenceOf(records({ run: undefined, calls: [] }), 1, ALLOWED);
    expect([noRun.gated.verdict, noRun.called.verdict, noRun.offered.verdict]).toEqual(['unverified', 'unverified', 'unverified']);
  });

  it('fails a tool outside the allowlist that was called or offered, and a read with no gate event', () => {
    const outside = gateEvidenceOf(records({ calls: [agent({ replyText: '[{"type":"tool_use","id":"t","name":"delete","input":{}}]', toolsOffered: ['answer', 'delete'] })], events: [{ action: 'entity.load', result: 'success', tokensIn: null, tokensOut: null, cacheReadTokens: null, cacheWriteTokens: null, modelCalls: null }] }), 1, ALLOWED);
    expect(outside.called).toMatchObject({ verdict: 'failed', outside: ['delete'] });
    expect(outside.offered).toMatchObject({ verdict: 'failed', outside: ['delete'] });
    const ungated = gateEvidenceOf(records({ calls: [agent()], events: [] }), 2, ALLOWED);
    expect(ungated.gated).toMatchObject({ verdict: 'failed', reads: 2, gateEvents: 0 });
  });

  it('passes the three pieces only with gate events for the reads, called tools inside the list and stored offered names inside the list', () => {
    const evidence = gateEvidenceOf(records({ calls: [call(1), agent()], events: [{ action: 'entity.degree_preview', result: 'success', tokensIn: null, tokensOut: null, cacheReadTokens: null, cacheWriteTokens: null, modelCalls: null }, { action: 'assistant.agent', result: 'success', tokensIn: 1, tokensOut: 1, cacheReadTokens: 0, cacheWriteTokens: 0, modelCalls: null }] }), 1, ALLOWED);
    expect([evidence.gated.verdict, evidence.called.verdict, evidence.offered.verdict]).toEqual(['passed', 'passed', 'passed']);
    expect(evidence.offered.names).toEqual(['answer', 'degree-preview', 'view']);
  });
});
