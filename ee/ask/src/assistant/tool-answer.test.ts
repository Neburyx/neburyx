import { ASSISTANT_NOT_ANSWERED_SENTENCE, type AskRunResult } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { removeAskFolders } from '../testing/ask-folder.js';
import { answerOf, derivedRuleResult, expandResult, fileQueryResult, lowerBoundResult, nodeOf, ok, okResult, rig, routeAsk, unknownCountResult, zeroResult, type Rig } from '../testing/assistant-rig.js';
import { assistantTurnAnswerSchema } from '@neburyx/contracts';
import { assembleText } from '../case-summary/assemble.js';
import { listedElements } from '../summary/index.js';
import { anchorItem } from '../summary/shared.js';
import { assembleResults, citationTitleOf } from './tool-answer.js';
import { TURN_CLOSED_ACTION } from './turn-audit.js';
import type { FixtureReply } from '../../../ai-runtime/src/testing/fixture.js';

afterAll(removeAskFolders);

const SHARED = routeAsk('shared', { id: 'A-1' });
const TOOL = ok(JSON.stringify({ tool: 'byId', values: { id: 'A-2' } }));
const DONE = ok('{"done":true}');
const sentences = (...list: { text: string; cites: string[] }[]) => ok(JSON.stringify({ sentences: list }));
const sequence = (...replies: FixtureReply[]) => {
  let next = 0;
  return () => replies[Math.min(next++, replies.length - 1)] ?? DONE;
};
const turn = (r: Rig) => (r.events.find((event) => event.action === TURN_CLOSED_ACTION)?.detail as { turn: Record<string, unknown> }).turn;
const setup = (answer: FixtureReply | (() => FixtureReply), extra: Parameters<typeof rig>[0] = {}) => rig({ reply: SHARED, step: sequence(TOOL, DONE), answer, run: () => ({ status: 'ok', result: okResult() }), ...extra });

describe('the title of a citation', () => {
  const answerWith = (title: string | undefined) => assistantTurnAnswerSchema.safeParse({ status: 'answered', route: 'ask', sentences: [{ text: 'Account A-1 is listed.', cites: ['r1'] }], citations: [{ key: 'r1', kind: 'entity', ref: { sourceId: 'a', entityType: 'widget', stableId: 'A-1' }, ...(title === undefined ? {} : { title }) }], coverage: { retrieval: 'x', summary: 'y' }, model: 'm', calls: 4, steps: 2, reads: [{ tool: 't', kind: 'intent', read: true, rows: 1, quality: 'exact', partial: false }, { tool: 'u', kind: 'intent', read: false }] });

  it('is cut to what the schema allows, counted as the schema counts it, for a long entity title, a relationship title of two long ends, emoji, and a cut that would fall inside a pair; and is none when blank', () => {
    const cases = ['é'.repeat(1000), `MADE_FROM: ${'A'.repeat(300)} → ${'B'.repeat(300)}`, '😀'.repeat(500), `${'a'.repeat(399)}😀tail`, 'Account A-1'];
    for (const title of cases) {
      const cut = citationTitleOf(title);
      expect(cut?.length).toBeLessThanOrEqual(400);
      expect(answerWith(cut).success).toBe(true);
      // the cut never ends in the first half of a pair
      expect(/[\uD800-\uDBFF]$/.test(cut ?? '')).toBe(false);
    }
    expect(citationTitleOf(`${'a'.repeat(399)}😀tail`)).toBe('a'.repeat(399));
    expect(citationTitleOf('😀'.repeat(500))).toBe('😀'.repeat(200));
    expect(citationTitleOf('Account A-1')).toBe('Account A-1');
    expect(citationTitleOf('   ')).toBeUndefined();
    expect(citationTitleOf(undefined)).toBeUndefined();
  });
});

describe('the answer after tool steps', () => {
  it('numbers each element the reads listed once, as a type and a title and nothing else, then writes a line for each read', () => {
    const { assembled, readKeys } = assembleResults([{ tool: 'shared', result: okResult() }, { tool: 'byId', result: okResult() }]);
    expect([...assembled.lines.values()]).toEqual(['r1: widget: Account A-1', 'r2: widget: Account A-2', expect.stringMatching(/^s1: read of shared: /), expect.stringMatching(/^s2: read of byId: /)]);
    expect(readKeys).toEqual(['s1', 's2']);
    expect([...assembled.keys.keys()]).toEqual(['r1', 'r2']);
    expect(assembled.carriesPropertyValues).toBe(false);
  });

  it('writes the read of an expansion in its own unit, 2 matches and not the 3 nodes with the anchor, and a relationship with its type once', () => {
    const { assembled } = assembleResults([{ tool: 'sentBy', result: expandResult() }]);
    expect(assembled.lines.get('s1')).toBe('s1: read of sentBy: 2 matches shown · exact');
    const relationship = [...assembled.lines.values()].find((line) => line.includes('SENT'));
    expect(relationship).toBe('r4: SENT: Account A-1 → Account A-2 | stored');
  });

  it('writes a read that found nothing as its own line, and a read with an exact zero with the zero', () => {
    const { assembled } = assembleResults([{ tool: 'shared', result: okResult() }, { tool: 'byId' }, { tool: 'sharedGadget', result: zeroResult() }]);
    expect(assembled.lines.get('s2')).toBe('s2: read of byId: found nothing');
    expect(assembled.lines.get('s3')).toContain('0 matches');
    expect(assembled.lines.get('s3')).toContain('exact');
  });

  it('drops a sentence that cites no key, and a key no read returned, and answers the fixed sentence when none is left', async () => {
    const r = await setup(sentences({ text: 'Account A-1 is listed.', cites: [] }, { text: 'Account A-2 is listed.', cites: ['n99'] }));
    expect(await answerOf(r.route.handler(r.request()))).toEqual({ status: 'not-answered', route: 'ask', sentence: ASSISTANT_NOT_ANSWERED_SENTENCE });
    expect(turn(r)).toMatchObject({ route: 'ask', outcome: 'refused', cause: 'not-answered' });
  });

  it('drops a number that is not in the lines it cites and keeps the supported sentence', async () => {
    const r = await setup(sentences({ text: 'There are 17 accounts.', cites: ['r1'] }, { text: 'Account A-1 is listed.', cites: ['r1'] }));
    const answer = await answerOf(r.route.handler(r.request()));
    expect(answer).toMatchObject({ status: 'answered', route: 'ask', sentences: [{ text: 'Account A-1 is listed.', cites: ['r1'] }] });
  });

  it('rejects a reply with verdict wording, whole, and answers the fixed sentence', async () => {
    const r = await setup(sentences({ text: 'Account A-1 is guilty of fraud.', cites: ['r1'] }, { text: 'Account A-2 is listed.', cites: ['r2'] }));
    expect(await answerOf(r.route.handler(r.request()))).toMatchObject({ status: 'not-answered' });
  });

  it('keeps a supported answer with the citations it names, its coverage written by the server, the model and the steps', async () => {
    const r = await setup(sentences({ text: 'Account A-1 and account A-2 are listed.', cites: ['r1', 'r2'] }));
    const answer = await answerOf(r.route.handler(r.request()));
    expect(answer).toMatchObject({ status: 'answered', route: 'ask', steps: 2, calls: 4, model: 'configured-model', citations: [{ key: 'r1', kind: 'entity' }, { key: 'r2', kind: 'entity' }], coverage: { summary: 'The answer cites 2 of the 2 elements the reads returned.' } });
    expect(turn(r)).toMatchObject({ outcome: 'answered', citedElements: 2, steps: 2 });
  });

  it('asks again for an answer that fails the checks, within the calls limit, and never beyond it', async () => {
    const bad = sentences({ text: 'Account A-1 is listed.', cites: [] });
    const good = sentences({ text: 'Account A-1 is listed.', cites: ['r1'] });
    const again = await setup(sequence(bad, good));
    expect(await answerOf(again.route.handler(again.request()))).toMatchObject({ status: 'answered', calls: 5 });
    const capped = await setup(sequence(bad, good), { maxCalls: 4 });
    expect(await answerOf(capped.route.handler(capped.request()))).toMatchObject({ status: 'not-answered' });
    expect(capped.fixture.calls.filter((call) => call.promptId === 'assistant.answer')).toHaveLength(1);
  });

  it('puts only the masked titles of the reads and the question in the answer call', async () => {
    const r = await setup(sentences({ text: 'Account A-1 is listed.', cites: ['r1'] }));
    await answerOf(r.route.handler(r.request({ sourceId: 'demo', investigationId: 'inv-1', message: 'who is on the account?', viewElementKeys: [], mask: true })));
    const call = r.fixture.calls.find((entry) => entry.promptId === 'assistant.answer');
    expect(call?.values).toContain('r1: widget: Account A-1');
    expect(r.runs.every((run) => run.mask)).toBe(true);
  });

  it('lets a sentence state that a read found nothing by citing the line of that read, checks its number against that line, and keeps the line out of the citations', async () => {
    const reads = [okResult(), zeroResult()];
    let next = 0;
    const r = await setup(
      sentences({ text: 'Account A-1 is listed.', cites: ['r1'] }, { text: 'The read of the second tool found 0 matches.', cites: ['s2'] }, { text: 'The read of the second tool found 3 matches.', cites: ['s2'] }),
      { run: () => ({ status: 'ok', result: reads[Math.min(next++, 1)] ?? zeroResult() }) },
    );
    const answer = await answerOf(r.route.handler(r.request()));
    expect(answer).toMatchObject({ status: 'answered', route: 'ask', steps: 2 });
    if (answer.status !== 'answered' || !('sentences' in answer)) throw new Error('not a sentences answer');
    expect(answer.sentences.map((sentence) => sentence.text)).toEqual(['Account A-1 is listed.', 'The read of the second tool found 0 matches.']);
    expect(answer.citations.map((citation) => citation.key)).toEqual(['r1']);
    expect(answer.coverage.retrieval).toMatch(/read 1, shared: .*; read 2, byId: .*0 matches/);
    expect(answer.coverage.summary).toBe('The answer cites 1 of the 2 elements the reads returned.');
    const call = r.fixture.calls.find((entry) => entry.promptId === 'assistant.answer');
    expect(call?.values).toContain('s2: read of byId: ');
  });

  it('keeps a sentence that cites only the line of a read, though it cites no element', async () => {
    const r = await setup(sentences({ text: 'The read of the second tool found 0 matches.', cites: ['s2'] }), { run: () => ({ status: 'ok', result: zeroResult() }) });
    const answer = await answerOf(r.route.handler(r.request()));
    expect(answer).toMatchObject({ status: 'answered', route: 'ask', citations: [] });
  });

  const second = (result: () => ReturnType<typeof okResult>) => {
    let next = 0;
    return { run: () => ({ status: 'ok' as const, result: next++ === 0 ? okResult() : result() }) };
  };
  const survivors = async (result: () => ReturnType<typeof okResult>, ...texts: { text: string; cites: string[] }[]) => {
    const r = await setup(sentences(...texts), second(result));
    const answer = await answerOf(r.route.handler(r.request()));
    return answer.status === 'answered' && 'sentences' in answer ? answer.sentences.map((sentence) => sentence.text) : [];
  };

  it('drops a number of a read whose count is a lower bound when the sentence leaves out the phrase of the line, and keeps it with the phrase', async () => {
    expect(await survivors(lowerBoundResult, { text: 'The second read found 149 more.', cites: ['s2'] }, { text: 'The second read found ≥ 149 more.', cites: ['s2'] })).toEqual(['The second read found ≥ 149 more.']);
  });

  it('drops a number of a read whose count is not known', async () => {
    expect(await survivors(unknownCountResult, { text: 'The second read found 1 match.', cites: ['s2'] }, { text: 'Account A-1 is listed.', cites: ['r1'] })).toEqual(['Account A-1 is listed.']);
  });

  it('takes the keys of the reads out of a sentence in brackets and removes a sentence that uses one in its grammar', async () => {
    expect(await survivors(zeroResult, { text: 'Account A-1 is listed (r1).', cites: ['r1'] }, { text: 'The second read found 0 matches (s2).', cites: ['s2'] }, { text: 'r1 shares a phone with r2.', cites: ['r1', 'r2'] })).toEqual(['Account A-1 is listed.', 'The second read found 0 matches.']);
  });

  it('removes a sentence that cites only the line of a read and names an element that read does not list, and keeps it when it cites that element too', async () => {
    expect(
      await survivors(zeroResult, { text: 'Account A-1 and the read found 0 matches.', cites: ['s2'] }, { text: 'Account A-1 and the read found 0 matches.', cites: ['r1', 's2'] }),
    ).toEqual(['Account A-1 and the read found 0 matches.']);
  });
});

describe('the properties in the lines of a tool result', () => {
  const AMOUNT = { key: 'figure', value: 4200, dataClass: 'number', masked: false };
  const OWNER = { key: 'alias', value: 'Name-1', dataClass: 'name', masked: true };
  const HIDDEN = { key: 'code', dataClass: 'text', masked: true };
  /** An expansion of A-1 whose second neighbour carries the amount, a masked name and a property the gate returned no value for. */
  const withProperties = (): AskRunResult => {
    const base = expandResult();
    if (base.templateId !== 'expand') throw new Error('an expansion');
    return { ...base, result: { ...base.result, nodes: base.result.nodes.map((node) => (node.ref.stableId === 'A-2' ? { ...node, properties: [AMOUNT, OWNER, HIDDEN] } : node)) } } as AskRunResult;
  };

  it('writes a node line with the properties as the view writes them: key, quoted value, and the masked and not shown marks', () => {
    const { assembled } = assembleResults([{ tool: 'sentBy', result: withProperties() }]);
    expect(assembled.lines.get('r2')).toBe('r2: widget: Account A-2 | figure: 4200; alias: "Name-1" (masked); code: (not shown)');
    expect(assembled.carriesPropertyValues).toBe(true);
    const view = assembleText({ nodes: [{ ...nodeOf('A-2'), properties: [AMOUNT, OWNER, HIDDEN] }], edges: [], unresolved: 0, omitted: false, notRetrieved: { quality: 'exact', value: 0, scope: 'test' }, uncounted: 0 } as never);
    expect(view.lines.get('n1')).toContain('figure: 4200; alias: "Name-1" (masked); code: (not shown)');
  });

  it('keeps the line of a node that holds no property as it was, and carries no property value', () => {
    const { assembled } = assembleResults([{ tool: 'sentBy', result: expandResult() }]);
    expect(assembled.lines.get('r1')).toBe('r1: widget: Account A-1');
    expect(assembled.carriesPropertyValues).toBe(false);
  });

  it('gives an element the view already holds the view\'s key and one line, and the result adds no second copy of its values', () => {
    const reading = { nodes: [{ ...nodeOf('A-2'), properties: [AMOUNT] }], edges: [], unresolved: 0, omitted: false, notRetrieved: { quality: 'exact', value: 0, scope: 'test' }, uncounted: 0 } as never;
    const view = assembleText(reading);
    const { assembled } = assembleResults([{ tool: 'sentBy', result: withProperties() }], view);
    const lines = [...assembled.lines.values()].filter((line) => line.includes('A-2'));
    expect(lines).toHaveLength(2);
    expect(lines.filter((line) => line.includes('figure: 4200'))).toHaveLength(1);
    expect([...assembled.keys.keys()].filter((key) => key.startsWith('n'))).toEqual(['n1']);
  });

  it('keeps the view\'s key, as an entity, for an element that the view and a result both hold', () => {
    const reading = { nodes: [{ ...nodeOf('A-2'), properties: [AMOUNT] }], edges: [], unresolved: 0, omitted: false, notRetrieved: { quality: 'exact', value: 0, scope: 'test' }, uncounted: 0 } as never;
    const { assembled } = assembleResults([{ tool: 'sentBy', result: withProperties() }], assembleText(reading));
    expect(assembled.keys.get('n1')).toMatchObject({ kind: 'entity' });
  });

  it('records in the closing event that property values were sent when a line of the answer call held one, and that none were when no line did, never a value', async () => {
    const withValue = await setup(sentences({ text: 'Account A-2 has an amount of 4200.', cites: ['r2'] }), { run: () => ({ status: 'ok', result: withProperties() }) });
    await answerOf(withValue.route.handler(withValue.request()));
    expect(turn(withValue)).toMatchObject({ propertyValuesSent: true });
    expect(JSON.stringify(withValue.events)).not.toContain('4200');
    const without = await setup(sentences({ text: 'Account A-1 and account A-2 are listed.', cites: ['r1', 'r2'] }));
    await answerOf(without.route.handler(without.request()));
    expect(turn(without)).toMatchObject({ propertyValuesSent: false });
  });

  it('counts the lines it writes in the input guard: a result whose properties pass maxInputTokens ends the turn at the limit input, with no answer call', async () => {
    const heavy = (): AskRunResult => {
      const base = withProperties();
      if (base.templateId !== 'expand') throw new Error('an expansion');
      return { ...base, result: { ...base.result, nodes: base.result.nodes.map((node) => ({ ...node, properties: [{ key: 'narrative', value: 'x'.repeat(20_000), dataClass: 'text', masked: false }] })) } } as AskRunResult;
    };
    const light = await setup(sentences({ text: 'Account A-2 has an amount of 4200.', cites: ['r2'] }), { maxInputTokens: 6000, run: () => ({ status: 'ok', result: withProperties() }) });
    expect(await answerOf(light.route.handler(light.request()))).toMatchObject({ status: 'answered' });
    const over = await setup(sentences({ text: 'Account A-2 is listed.', cites: ['r2'] }), { maxInputTokens: 6000, run: () => ({ status: 'ok', result: heavy() }) });
    expect(await answerOf(over.route.handler(over.request()))).toMatchObject({ status: 'limit', limit: 'input' });
    expect(over.fixture.calls.filter((call) => call.promptId === 'assistant.answer')).toHaveLength(0);
  });

  it('makes the answer call for a plain Ask turn whose first read carries property values, and answers with the amount cited to the line', async () => {
    const r = await rig({ reply: SHARED, step: sequence(DONE), answer: sentences({ text: 'Account A-2 has an amount of 4200.', cites: ['r2'] }), run: () => ({ status: 'ok', result: withProperties() }) });
    const answer = await answerOf(r.route.handler(r.request()));
    expect(answer).toMatchObject({ status: 'answered', route: 'ask', sentences: [{ text: 'Account A-2 has an amount of 4200.', cites: ['r2'] }] });
    expect(r.fixture.calls.filter((call) => call.promptId === 'assistant.answer')).toHaveLength(1);
    expect(turn(r)).toMatchObject({ modelCalls: 3, propertyValuesSent: true });
  });

  it('keeps the fixed Ask sentence, with no answer call, when the first read carries no property value', async () => {
    const r = await rig({ reply: SHARED, step: sequence(DONE), answer: sentences({ text: 'Account A-1 and account A-2 are listed.', cites: ['r1', 'r2'] }), run: () => ({ status: 'ok', result: okResult() }) });
    const answer = await answerOf(r.route.handler(r.request()));
    expect(answer).toMatchObject({ status: 'answered', route: 'ask', answer: { answered: { result: { templateId: 'shared-attribute' } } } });
    expect(r.fixture.calls.filter((call) => call.promptId === 'assistant.answer')).toHaveLength(0);
    expect(turn(r)).toMatchObject({ modelCalls: 2, propertyValuesSent: false });
  });

  it('keeps the fixed Ask sentence when the only property values of the read are the id and the title of its elements', async () => {
    const base = expandResult();
    if (base.templateId !== 'expand') throw new Error('an expansion');
    const named = { ...base, result: { ...base.result, nodes: base.result.nodes.map((node) => ({ ...node, properties: [{ key: 'code', value: node.ref.stableId, dataClass: 'text', masked: false }, { key: 'label', value: node.display.title, dataClass: 'text', masked: false }] })) } } as AskRunResult;
    const r = await rig({ reply: SHARED, step: sequence(DONE), answer: sentences({ text: 'Account A-2 is listed.', cites: ['r2'] }), run: () => ({ status: 'ok', result: named }) });
    expect(await answerOf(r.route.handler(r.request()))).toMatchObject({ status: 'answered', route: 'ask', answer: { answered: { result: { templateId: 'expand' } } } });
    expect(r.fixture.calls.filter((call) => call.promptId === 'assistant.answer')).toHaveLength(0);
  });

  it('leaves the Ask answer as it was when the answer over the property values keeps no sentence', async () => {
    const r = await rig({ reply: SHARED, step: sequence(DONE), answer: sentences({ text: 'Account A-2 has an amount of 4300.', cites: ['r2'] }), run: () => ({ status: 'ok', result: withProperties() }) });
    const answer = await answerOf(r.route.handler(r.request()));
    expect(answer).toMatchObject({ status: 'answered', route: 'ask', answer: { answered: { result: { templateId: 'expand' } } } });
    expect(JSON.stringify(answer)).not.toContain('4300');
  });

  it('answers with the card that the mapping has no description for a type the question asks about, when the answer over the property values says so', async () => {
    const mapping = { typeDescriptions: () => ({ entityTypes: [{ type: 'widget', label: 'Widget', displayName: 'Widget' }], relationshipTypes: [] }) };
    const r = await rig({ reply: SHARED, step: sequence(DONE), answer: ok('{"noDescription":["widget"]}'), run: () => ({ status: 'ok', result: withProperties() }) });
    expect(await answerOf(r.route.handler(r.request(undefined, mapping)))).toMatchObject({ status: 'no-description', route: 'ask', names: ['Widget'] });
  });

  it('keeps the fixed Ask sentence when no model call is left for the answer', async () => {
    const r = await rig({ reply: SHARED, step: sequence(DONE), maxCalls: 2, answer: sentences({ text: 'Account A-2 has an amount of 4200.', cites: ['r2'] }), run: () => ({ status: 'ok', result: withProperties() }) });
    const answer = await answerOf(r.route.handler(r.request()));
    expect(answer).toMatchObject({ status: 'answered', route: 'ask', answer: { answered: { result: { templateId: 'expand' } } } });
    expect(r.fixture.calls.filter((call) => call.promptId === 'assistant.answer')).toHaveLength(0);
  });

  it('lists an anchor held by reference only without a node, so that no property is invented for it', () => {
    const listed = anchorItem(nodeOf('A-9').ref, new Map());
    expect(listed.node).toBeUndefined();
    expect(listed).toMatchObject({ type: 'widget', title: 'A-9' });
  });

  it('carries the node object of each node a result lists, for each kind of result that lists nodes', () => {
    for (const result of [withProperties(), okResult(), derivedRuleResult(), fileQueryResult()]) {
      const listed = [...(listedElements(result)?.values() ?? [])].filter((item) => 'entityType' in item.element);
      expect(listed.length).toBeGreaterThan(0);
      for (const item of listed) expect(item.node).toBeDefined();
    }
  });

  it('keeps a sentence that states the amount of a transaction a tool returned, and drops the same sentence with an amount the line does not hold', async () => {
    const kept = await setup(sentences({ text: 'Account A-2 has an amount of 4200.', cites: ['r2'] }), { run: () => ({ status: 'ok', result: withProperties() }) });
    const keptAnswer = await answerOf(kept.route.handler(kept.request()));
    expect(keptAnswer).toMatchObject({ status: 'answered', sentences: [{ text: 'Account A-2 has an amount of 4200.' }] });
    const planted = await setup(sentences({ text: 'Account A-2 has an amount of 4300.', cites: ['r2'] }), { run: () => ({ status: 'ok', result: withProperties() }) });
    expect(await answerOf(planted.route.handler(planted.request()))).not.toMatchObject({ status: 'answered', sentences: [{ text: 'Account A-2 has an amount of 4300.' }] });
  });
});

describe('the lines of the relationships of a tool result', () => {
  const SRC = 'demo';
  const ref = (stableId: string) => ({ sourceId: SRC, entityType: 'widget', stableId });
  /** An expansion of A-1 with one stored relationship that carries a time and an amount, and one aggregate with an estimated member count. */
  const withEdges = (): AskRunResult => {
    const base = expandResult();
    if (base.templateId !== 'expand') throw new Error('an expansion');
    const [stored] = base.result.edges;
    if (stored === undefined) throw new Error('an edge');
    const aggregate = {
      ref: { sourceId: SRC, aggregate: { type: 'PAID', from: ref('A-1'), to: ref('A-3') } },
      from: ref('A-1'),
      to: ref('A-3'),
      type: 'PAID',
      direction: 'out',
      semantics: 'unknown',
      memberCount: { quality: 'estimated', value: 5, scope: 'test' },
      observedFirst: '2026-01-01',
      observedLast: '2026-02-01',
      properties: [],
      evidenceRefs: [],
      qualityFlags: [],
    };
    return { ...base, result: { ...base.result, edges: [{ ...stored, observedAt: '2026-01-02', properties: [{ key: 'figure', value: 12.5, dataClass: 'number', masked: false }] }, aggregate] } } as AskRunResult;
  };

  it('writes a stored relationship with its type, its ends in the direction the source holds it, its time and its projected properties, as the view writes them', () => {
    const { assembled } = assembleResults([{ tool: 'sentBy', result: withEdges() }]);
    expect(assembled.lines.get('r4')).toBe('r4: SENT: Account A-1 → Account A-2 | stored | observed at "2026-01-02" | figure: 12.5');
    expect(assembled.carriesPropertyValues).toBe(true);
    expect(assembled.lines.get('r4')?.indexOf('Account A-1')).toBeLessThan(assembled.lines.get('r4')?.indexOf('Account A-2') ?? 0);
  });

  it('writes an aggregate relationship with no property and the rest as the view writes it: its times and its member count phrase', () => {
    const { assembled, } = assembleResults([{ tool: 'sentBy', result: withEdges() }]);
    expect(assembled.lines.get('r5')).toBe('r5: PAID: Account A-1 → Account A-3 | unknown | observed "2026-01-01" to "2026-02-01" | members: ~5 (estimated)');
    expect(assembled.inexactCounts).toContainEqual({ phrase: '~5 (estimated)', value: '5' });
  });

  it('gives a relationship that two reads list one key and one line', () => {
    const { assembled } = assembleResults([{ tool: 'sentBy', result: withEdges() }, { tool: 'again', result: withEdges() }]);
    expect([...assembled.lines.values()].filter((line) => line.includes('SENT:'))).toHaveLength(1);
  });

  it('says in the line of a read that lists elements and no relationship that no relationship was listed, and not in the line of a read that lists one', () => {
    const { assembled } = assembleResults([{ tool: 'shared', result: okResult() }, { tool: 'sentBy', result: expandResult() }]);
    expect(assembled.lines.get('s1')).toMatch(/ · no relationship listed$/);
    expect(assembled.lines.get('s2')).not.toContain('no relationship listed');
  });

  it('says it of a search that returns nodes only, and not of a search that returns an evidence hit, which is a relationship', () => {
    const exact = (value: number) => ({ quality: 'exact' as const, value, scope: 's' });
    const search = (hits: unknown[]): AskRunResult =>
      ({
        templateId: 'search',
        result: { sourceId: 'demo', exact: [nodeOf('A-1')], exactMatches: [], cap: 25, searchable: true, counts: { exact: exact(1) }, disabledTypes: [], related: { hits: [], count: exact(0), searchable: true, disabledTypes: [] }, evidence: { hits, count: exact(hits.length), searchable: true, disabledRelationshipTypes: [] }, failures: [], dropped: {}, warnings: [], elapsedMs: 1 },
      }) as never;
    const hit = { aggregate: { type: 'PAID', from: nodeOf('A-1').ref, to: nodeOf('A-2').ref }, members: [], memberCount: exact(1), rules: [] };
    expect(assembleResults([{ tool: 'byReference', result: search([]) }]).assembled.lines.get('s1')).toMatch(/ · no relationship listed$/);
    expect(assembleResults([{ tool: 'byReference', result: search([hit]) }]).assembled.lines.get('s1')).not.toContain('no relationship listed');
  });

  it('does not say it of a read that found nothing to list, or of a read of the application\'s own tools', () => {
    const { assembled } = assembleResults([{ tool: 'typology', typology: ['A shape.'] }, { tool: 'shared' }]);
    expect(assembled.lines.get('s1')).not.toContain('no relationship listed');
    expect(assembled.lines.get('s2')).not.toContain('no relationship listed');
  });

  it('lets a sentence state that the direction is not known by citing the line of a read that lists no relationship', async () => {
    const r = await setup(sentences({ text: 'The read listed no relationship, so the direction is not known.', cites: ['s1'] }), { run: () => ({ status: 'ok', result: okResult() }) });
    const answer = await answerOf(r.route.handler(r.request()));
    expect(answer).toMatchObject({ status: 'answered', sentences: [{ cites: ['s1'] }] });
    const call = r.fixture.calls.find((entry) => entry.promptId === 'assistant.answer');
    expect(call?.values).toContain('no relationship listed');
  });
});

describe('the meaning lines of the answer after tool steps', () => {
  const WIDGET = 'A widget is a small unit that holds up to 12 parts.';
  const described = { typeDescriptions: () => ({ entityTypes: [{ type: 'widget', label: 'Widget', displayName: 'widget', description: WIDGET }], relationshipTypes: [] }) };

  it('sends the description of a type the reads returned and keeps a sentence that cites it, with a description citation', async () => {
    const r = await setup(sentences({ text: 'A widget is a small unit that holds up to 12 parts.', cites: ['m1'] }, { text: 'Account A-1 is listed.', cites: ['r1'] }));
    const answer = await answerOf(r.route.handler(r.request(undefined, described)));
    const call = r.fixture.calls.find((entry) => entry.promptId === 'assistant.answer');
    expect(call?.values).toContain(`m1: entity type widget: ${JSON.stringify(WIDGET)}`);
    if (answer.status !== 'answered' || !('sentences' in answer)) throw new Error('not answered');
    expect(answer.sentences).toHaveLength(2);
    expect(answer.citations.map((citation) => citation.kind)).toEqual(['entity', 'description']);
  });

  it('sends nothing more when the mapping has no description', async () => {
    const r = await setup(sentences({ text: 'Account A-1 is listed.', cites: ['r1'] }));
    await answerOf(r.route.handler(r.request()));
    expect(r.fixture.calls.find((entry) => entry.promptId === 'assistant.answer')?.values).not.toContain('What the types mean');
  });

  it('takes a reply that names an undescribed type in play through its own hook, alone and beside sentences', async () => {
    const mapping = { typeDescriptions: () => ({ entityTypes: [{ type: 'widget', label: 'Widget', displayName: 'Widget' }], relationshipTypes: [] }) };
    const alone = await setup(ok('{"noDescription":["widget"]}'));
    expect(await answerOf(alone.route.handler(alone.request(undefined, mapping)))).toEqual({ status: 'no-description', route: 'ask', sentence: 'The mapping has no description for Widget, so I cannot say what it means.', names: ['Widget'] });
    const beside = await setup(ok(JSON.stringify({ sentences: [{ text: 'Account A-1 is listed.', cites: ['r1'] }], noDescription: ['Widget'] })));
    expect(await answerOf(beside.route.handler(beside.request(undefined, mapping)))).toMatchObject({ status: 'answered', noDescription: 'The mapping has no description for Widget, so I cannot say what it means.' });
  });
});

describe('the label of an intent in a turn', () => {
  const intents = {
    byId: { label: 'Account by id', parameters: ['id'], query: 'MATCH (n) WHERE n.id = $id RETURN n LIMIT 5' },
    shared: { label: 'Accounts at the same bank', parameters: ['id'], template: 'shared-attribute', settings: { ref: { entityType: 'widget', stableId: '$id' }, attributeType: 'shape', via: 'USES_SHAPE' } },
  };

  it('is written as `read of <label>` in the lines the model reads, carried on each read of the answer, and the request still names the id', async () => {
    const r = await setup(sentences({ text: 'Account A-1 is listed.', cites: ['r1'] }), { intents });
    const answer = await answerOf(r.route.handler(r.request()));
    const call = r.fixture.calls.find((entry) => entry.promptId === 'assistant.answer');
    expect(call?.values).toContain('s1: read of Accounts at the same bank:');
    expect(call?.values).toContain('s2: read of Account by id:');
    const stepCall = r.fixture.calls.find((entry) => entry.promptId === 'assistant.step');
    expect(stepCall?.instructions).toContain('byId(id) - Account by id');
    if (answer.status !== 'answered' || answer.route !== 'ask' || answer.reads === undefined) throw new Error('not an Ask answer');
    expect(answer.reads.map((read) => [read.tool, read.label])).toEqual([['shared', 'Accounts at the same bank'], ['byId', 'Account by id']]);
  });

  it('leaves a folder without labels as it was: no label on a read and the id in the lines', async () => {
    const r = await setup(sentences({ text: 'Account A-1 is listed.', cites: ['r1'] }));
    const answer = await answerOf(r.route.handler(r.request()));
    expect(r.fixture.calls.find((entry) => entry.promptId === 'assistant.answer')?.values).toContain('s1: read of shared:');
    if (answer.status !== 'answered' || answer.route !== 'ask' || answer.reads === undefined) throw new Error('not an Ask answer');
    expect(answer.reads.some((read) => 'label' in read)).toBe(false);
  });
});

