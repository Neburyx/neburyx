import { describe, expect, it } from 'vitest';
import { gateEvidenceOf } from './gate-evidence.js';
import { citedLinesOf, linesOfAnswer } from './lines.js';
import type { TurnRecords } from './records.js';

const call = (number: number, over: Record<string, unknown> = {}) => ({ number, startedAt: '', durationMs: 1, status: 'answered', failureKind: null, errorClass: null, errorCode: null, tokensIn: 1, tokensOut: 1, instructionsSha256: 'sha-x', instructionsText: '', valuesText: '', replyText: null as string | null, toolsOffered: null as readonly string[] | null, ...over });
const records = (over: Partial<TurnRecords> = {}): TurnRecords => ({ traceId: 'tr-1', run: { id: 'run-1', outcome: 'ok', finished: true, calls: 3, settings: {} }, calls: [], events: [], summaryCalls: 0, summaryUsage: [], reconciled: undefined, problems: [], ...over });

const FIRST = 'human: Question:\nhow many?\nai: [{"type":"tool_use","id":"t1","name":"view","input":{}}] [{"name":"view","args":{}}]\ntool: Keys are renumbered after every read: cite only keys of the latest result.\nn1 | "account" | title: "Account W-1" | id: "W-1"\n';
const SECOND = `${FIRST}ai: [{"type":"tool_use","id":"t2","name":"degree-preview","input":{}}] [{"name":"degree-preview","args":{}}]\ntool: Keys are renumbered after every read: cite only keys of the latest result.\nn1 | "account" | title: "Account W-1" | id: "W-1"\ns1: read of degree-preview: 6 shown · all types 184,533 (exact)`;
const ANSWER_REPLY = '[{"type":"tool_use","id":"t3","name":"answer","input":{"sentences":[{"text":"x","cites":["n1","s1"]}]}}]';

describe('the lines an answer cites', () => {
  it('takes the lines of the latest read when the answer check replied after it, so a reply that holds no line does not hide them', () => {
    const values = `${FIRST}ai: [{"name":"answer","args":{}}]\ntool: Checked: 1 sentences kept, 1 removed. Call answer again with sentences that cite elements, or reply "Done.".\nRemoved: "x"`;
    const lines = linesOfAnswer({ ...records(), calls: [call(1, { replyText: ANSWER_REPLY, valuesText: values })] });
    expect(lines?.lines.get('n1')).toContain('Account W-1');
  });

  it('counts the cites that are not text keys or whose sentence has no list of cites, and invents no line for them', () => {
    const cited = citedLinesOf({ sentences: [{ text: 'a', cites: ['n1', 7] }, { text: 'b' }, { text: 'c', cites: 'n1' }] }, undefined);
    expect(cited.malformed).toBe(3);
    expect(cited.missing).toEqual(['n1']);
    expect(cited.mapped.size).toBe(0);
  });

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
  const agent = (over: Record<string, unknown> = {}) => call(2, { instructionsSha256: 'sha-agent', replyText: '[{"type":"tool_use","id":"t","name":"view","input":{}}] [{"name":"view","args":{}}]', toolsOffered: ['answer', 'degree-preview', 'view'], ...over });
  const event = (action: string, over: Record<string, unknown> = {}) => ({ action, result: 'success', sourceId: 'demo', tokensIn: null, tokensOut: null, cacheReadTokens: null, cacheWriteTokens: null, modelCalls: null, ...over });
  const WITHOUT_GATE = ['answer', 'view'];
  const router = call(1, { instructionsSha256: 'sha-router' });
  const expected = (reads: number) => ({ reads, sourceId: 'demo' });

  it('reports a piece that cannot be established as unverified, never as passed: no stored tool names, no run record, a reply whose tool calls cannot be read', () => {
    const noNames = gateEvidenceOf(records({ calls: [router, agent({ toolsOffered: null })] }), expected(1), ALLOWED, WITHOUT_GATE);
    expect(noNames.offered.verdict).toBe('unverified');
    expect(noNames.offered.callsWithoutNames).toBe(1);
    const noRun = gateEvidenceOf(records({ run: undefined, calls: [] }), expected(1), ALLOWED, WITHOUT_GATE);
    expect([noRun.gated.verdict, noRun.called.verdict, noRun.offered.verdict]).toEqual(['unverified', 'unverified', 'unverified']);
    const broken = gateEvidenceOf(records({ calls: [router, agent({ replyText: 'text [{"name":"view","args":' })] }), expected(0), ALLOWED, WITHOUT_GATE);
    expect(broken.called).toMatchObject({ verdict: 'unverified', unparsed: 1 });
  });

  it('identifies an agent call by its instructions, not by what its reply holds, so a call with no recognisable reply still has its offered names checked', () => {
    const silent = gateEvidenceOf(records({ calls: [router, agent({ replyText: null, toolsOffered: ['answer', 'delete'] })] }), expected(0), ALLOWED, WITHOUT_GATE);
    expect(silent.offered).toMatchObject({ verdict: 'failed', outside: ['delete'] });
  });

  it('reads the tool calls as the audited model stores them, a list of name and args after the content', () => {
    const outside = gateEvidenceOf(records({ calls: [router, agent({ replyText: 'thinking [{"name":"delete","args":{"id":"x"}}]', toolsOffered: ['answer'] })] }), expected(0), ALLOWED, WITHOUT_GATE);
    expect(outside.called).toMatchObject({ verdict: 'failed', outside: ['delete'], names: ['delete'] });
  });

  it('fails a tool outside the allowlist that was called or offered, and a read with no gate event', () => {
    const outside = gateEvidenceOf(records({ calls: [router, agent({ replyText: '[{"type":"tool_use","id":"t","name":"delete","input":{}}]', toolsOffered: ['answer', 'delete'] })], events: [event('entity.load')] }), expected(1), ALLOWED, WITHOUT_GATE);
    expect(outside.called).toMatchObject({ verdict: 'failed', outside: ['delete'] });
    expect(outside.offered).toMatchObject({ verdict: 'failed', outside: ['delete'] });
    const ungated = gateEvidenceOf(records({ calls: [router, agent()], events: [] }), expected(2), ALLOWED, WITHOUT_GATE);
    expect(ungated.gated).toMatchObject({ verdict: 'failed', reads: 2, gateEvents: 0 });
  });

  it('passes a turn that made no agent call, as a view answer, the overview of a refusal and an answer from Ask do not, when its records are complete, and leaves it unverified when they are not', () => {
    const view = call(2, { instructionsSha256: 'sha-view', replyText: '{"sentences":[{"text":"x","cites":["n1"]}]}', toolsOffered: null });
    const none = gateEvidenceOf(records({ calls: [router, view], events: [] }), expected(0), ALLOWED, WITHOUT_GATE);
    expect([none.gated.verdict, none.called.verdict, none.offered.verdict]).toEqual(['passed', 'passed', 'passed']);
    const unfinished = gateEvidenceOf(records({ calls: [router, view], problems: ['no closing event for this turn in the audit events'] }), expected(0), ALLOWED, WITHOUT_GATE);
    expect([unfinished.gated.verdict, unfinished.called.verdict, unfinished.offered.verdict]).toEqual(['unverified', 'unverified', 'unverified']);
  });

  it('counts only events of a read of the turn\'s source that ended in success: a failed event, an event of another source and a model or turn event are not a gated read', () => {
    const events = [event('entity.degree_preview', { result: 'failed' }), event('entity.load', { sourceId: 'other' }), event('assistant.agent'), event('ai.case-summary'), event('assistant.turn.closed')];
    const evidence = gateEvidenceOf(records({ calls: [router, agent()], events }), expected(1), ALLOWED, WITHOUT_GATE);
    expect(evidence.gated).toMatchObject({ verdict: 'failed', gateEvents: 0, failedEvents: 1 });
    const good = gateEvidenceOf(records({ calls: [router, agent()], events: [...events, event('entity.degree_preview', { result: 'partial' })] }), expected(1), ALLOWED, WITHOUT_GATE);
    expect(good.gated).toMatchObject({ verdict: 'passed', gateEvents: 1 });
  });

  it('counts the reads the model made from its own calls, so a read tool called twice with one gate event fails even when the answer lists none', () => {
    const twice = agent({ replyText: '[{"type":"tool_use","id":"t","name":"degree-preview","input":{}}] [{"name":"degree-preview","args":{}},{"name":"degree-preview","args":{}}]' });
    const evidence = gateEvidenceOf(records({ calls: [router, twice], events: [event('entity.degree_preview')] }), expected(0), ALLOWED, WITHOUT_GATE);
    expect(evidence.gated).toMatchObject({ verdict: 'failed', reads: 2, gateEvents: 1 });
    const viewOnly = gateEvidenceOf(records({ calls: [router, agent()], events: [] }), expected(0), ALLOWED, WITHOUT_GATE);
    expect(viewOnly.gated).toMatchObject({ verdict: 'passed', reads: 0 });
  });

  it('passes the three pieces only with gate events for the reads, called tools inside the list and stored offered names inside the list', () => {
    const evidence = gateEvidenceOf(records({ calls: [router, agent()], events: [event('entity.degree_preview'), event('assistant.agent', { tokensIn: 1, tokensOut: 1, cacheReadTokens: 0, cacheWriteTokens: 0 })] }), expected(1), ALLOWED, WITHOUT_GATE);
    expect([evidence.gated.verdict, evidence.called.verdict, evidence.offered.verdict]).toEqual(['passed', 'passed', 'passed']);
    expect(evidence.offered.names).toEqual(['answer', 'degree-preview', 'view']);
  });
});
