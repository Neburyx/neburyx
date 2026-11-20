import { ASSISTANT_NOT_ANSWERED_SENTENCE } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { removeAskFolders } from '../testing/ask-folder.js';
import { answerOf, expandResult, lowerBoundResult, ok, okResult, rig, routeAsk, unknownCountResult, zeroResult, type Rig } from '../testing/assistant-rig.js';
import { assistantTurnAnswerSchema } from '@neburyx/contracts';
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
    expect(relationship).toBe('r4: SENT: Account A-1 → Account A-2');
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

describe('the meaning lines of the answer after tool steps', () => {
  const WIDGET = 'A widget is a small unit that holds up to 12 parts.';
  const described = { typeDescriptions: () => ({ entityTypes: [{ type: 'widget', label: 'Widget', displayName: 'widget', description: WIDGET }], relationshipTypes: [] }) };

  it('sends the description of a type the reads returned and keeps a sentence that cites it, with a description citation', async () => {
    const r = await setup(sentences({ text: 'A widget is a small unit that holds up to 12 parts.', cites: ['m1'] }, { text: 'Account A-1 is listed.', cites: ['r1'] }));
    const answer = await answerOf(r.route.handler(r.request(undefined, described)));
    const call = r.fixture.calls.find((entry) => entry.promptId === 'assistant.answer');
    expect(call?.values).toContain(`m1: entity type widget: ${JSON.stringify(WIDGET)}`);
    if (answer.status !== 'answered') throw new Error('not answered');
    expect(answer.sentences).toHaveLength(2);
    expect(answer.citations.map((citation) => citation.kind)).toEqual(['entity', 'description']);
  });

  it('sends nothing more when the mapping has no description', async () => {
    const r = await setup(sentences({ text: 'Account A-1 is listed.', cites: ['r1'] }));
    await answerOf(r.route.handler(r.request()));
    expect(r.fixture.calls.find((entry) => entry.promptId === 'assistant.answer')?.values).not.toContain('What the types mean');
  });
});
