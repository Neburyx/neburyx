import type { StoredAnswer, StoredTurnText } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { presentThread } from './thread-present.js';
import type { AssistantThreadRead } from './thread-store.js';

const REF = { sourceId: 'demo', entityType: 'widget', stableId: 'A-1' };
const turn = (stored?: StoredTurnText) => ({ seq: 1, at: '2026-11-18T10:00:00.000Z', route: 'view' as const, outcome: 'answered' as const, citedElements: 1, steps: 0, ...(stored === undefined ? {} : { stored }) });
const read = (...turns: ReturnType<typeof turn>[]): AssistantThreadRead => ({ turns, earlierTurns: 0, previousThreadClearedAt: null });
const answer: StoredAnswer = {
  blocks: [
    {
      kind: 'sentences',
      items: [
        { form: 'frozen', text: 'Two items are listed.', cites: [REF] },
        { form: 'bound', segments: [{ element: REF, property: 'holder' }, { literal: ' is listed.' }], cites: [REF] },
        { form: 'unbound', text: 'Jordan is listed.', cites: [REF] },
      ],
    },
    { kind: 'table', columns: [{ form: 'frozen', text: 'Holder' }], rows: [{ cells: [{ form: 'unbound', text: 'Jordan Lee' }], cites: [REF] }] },
  ],
};
const sentences = (shown: ReturnType<typeof presentThread>) => (shown.turns[0]?.answer?.blocks[0]?.kind === 'sentences' ? shown.turns[0].answer.blocks[0].items.map((entry) => entry.item) : []);
const cells = (shown: ReturnType<typeof presentThread>) => (shown.turns[0]?.answer?.blocks[1]?.kind === 'table' ? shown.turns[0].answer.blocks[1].rows[0]?.cells : undefined);
const writtenOff = (over: Partial<StoredTurnText> = {}): StoredTurnText => ({ question: 'Who?', maskOn: false, answer, sensitivityVersion: 'sv1:a', ...over });

describe('what a read sends of a stored thread', () => {
  it('sends a bound item as segments and a frozen one as stored, with the mask on or off, and never a bound value', () => {
    for (const mask of [true, false]) {
      const shown = presentThread(read(turn(writtenOff())), mask, 'sv1:a');
      expect(sentences(shown)[0]).toEqual({ state: 'text', text: 'Two items are listed.' });
      expect(sentences(shown)[1]).toEqual({ state: 'segments', segments: [{ element: REF, property: 'holder' }, { literal: ' is listed.' }] });
    }
  });

  it('withholds an unbound item under the mask, with a marker and no text, sends the other items, and sends it as stored with the mask off', () => {
    const on = presentThread(read(turn(writtenOff())), true, 'sv1:a');
    expect(sentences(on)[2]).toEqual({ state: 'withheld' });
    expect(cells(on)).toEqual([{ state: 'withheld' }]);
    expect(JSON.stringify(on)).not.toContain('Jordan');
    const off = presentThread(read(turn(writtenOff())), false, 'sv1:a');
    expect(sentences(off)[2]).toEqual({ state: 'text', text: 'Jordan is listed.' });
    expect(cells(off)).toEqual([{ state: 'text', text: 'Jordan Lee' }]);
  });

  it('sends a turn written with the mask on as stored under either state, when its version is the current one', () => {
    const masked: StoredAnswer = { blocks: [{ kind: 'sentences', items: [{ form: 'frozen', text: 'The holder is ****** here.', cites: [REF] }] }] };
    for (const mask of [true, false]) {
      const shown = presentThread(read(turn({ question: 'Who?', maskOn: true, answer: masked, sensitivityVersion: 'sv1:a' })), mask, 'sv1:a');
      expect(sentences(shown)).toEqual([{ state: 'text', text: 'The holder is ****** here.' }]);
      expect(shown.turns[0]?.question).toBe('Who?');
    }
  });

  it.each([['another version', 'sv1:b', 'sv1:a'], ['no stored version', undefined, 'sv1:a'], ['no current version', 'sv1:a', undefined]])('withholds every item of the turn under the mask, whatever it was written under, when there is %s, and sends them as stored with the mask off', (_name, stored, current) => {
    for (const maskOn of [false, true]) {
      const turnText = writtenOff({ maskOn, ...(stored === undefined ? { sensitivityVersion: undefined } : { sensitivityVersion: stored }) });
      const on = presentThread(read(turn(turnText)), true, current);
      expect(sentences(on)).toEqual([{ state: 'withheld' }, { state: 'withheld' }, { state: 'withheld' }]);
      expect(JSON.stringify(on)).not.toMatch(/Jordan|Two items|holder|segments/u);
      const off = presentThread(read(turn(turnText)), false, current);
      expect(sentences(off)[2]).toEqual({ state: 'text', text: 'Jordan is listed.' });
    }
  });

  it('sends a turn kept before text was kept as it was, with no question and no answer, and a turn with a question and no answer with the question alone', () => {
    const before = presentThread(read(turn()), true, 'sv1:a');
    expect(before.turns[0]).not.toHaveProperty('answer');
    expect(before.turns[0]).not.toHaveProperty('question');
    const alone = presentThread(read(turn({ question: 'Who?', maskOn: false })), true, 'sv1:a');
    expect(alone.turns[0]).toMatchObject({ question: 'Who?' });
    expect(alone.turns[0]).not.toHaveProperty('answer');
  });

  it('sends the model and the lines of coverage of an answer as they were stored, under either state of the mask and also when its version is not verified, and nothing for an answer stored without them', () => {
    const made = { model: 'fixture-model', coverage: { retrieval: '27 shown · ≥ 184,506 not yet retrieved (lower bound)', summary: 'The answer cites 3 of the 27 elements the reads returned.' } };
    for (const [mask, version] of [[true, 'sv1:a'], [false, 'sv1:a'], [true, 'sv1:other'], [true, undefined]] as const) {
      const shown = presentThread(read(turn(writtenOff({ answer: { ...answer, ...made } }))), mask, version);
      expect(shown.turns[0]?.answer).toMatchObject(made);
    }
    const without = presentThread(read(turn(writtenOff())), false, 'sv1:a');
    expect(without.turns[0]?.answer).not.toHaveProperty('model');
    expect(without.turns[0]?.answer).not.toHaveProperty('coverage');
  });

  it('sends a list block item by item as it sends sentences, its label withheld under the mask when it is unbound, and an item that is bound as segments', () => {
    const list: StoredAnswer = { blocks: [{ kind: 'list', label: { form: 'unbound', text: 'Jordan Lee holds' }, items: [{ form: 'frozen', text: 'Two items.', cites: [REF] }, { form: 'bound', segments: [{ element: REF, property: 'holder' }], cites: [REF] }, { form: 'unbound', text: 'Jordan.', cites: [REF] }] }] };
    const masked = presentThread(read(turn(writtenOff({ answer: list }))), true, 'sv1:a').turns[0]?.answer?.blocks[0];
    expect(masked).toEqual({ kind: 'list', label: { state: 'withheld' }, items: [{ item: { state: 'text', text: 'Two items.' }, cites: [REF] }, { item: { state: 'segments', segments: [{ element: REF, property: 'holder' }] }, cites: [REF] }, { item: { state: 'withheld' }, cites: [REF] }] });
    const open = presentThread(read(turn(writtenOff({ answer: list }))), false, 'sv1:a').turns[0]?.answer?.blocks[0];
    expect(open).toMatchObject({ label: { state: 'text', text: 'Jordan Lee holds' }, items: [{ item: { state: 'text' } }, { item: { state: 'segments' } }, { item: { state: 'text', text: 'Jordan.' } }] });
  });

  it('keeps the count of the earlier turns and the clearing', () => {
    expect(presentThread({ turns: [], earlierTurns: 4, previousThreadClearedAt: '2026-11-18T10:00:00.000Z' }, false, undefined)).toEqual({ turns: [], earlierTurns: 4, previousThreadClearedAt: '2026-11-18T10:00:00.000Z' });
  });

  it('withholds an unbound item under the mask whatever mask the turn was written under, a refusal with its overview and an unbound column label when the version is not verified or the item may hold a value, and sends no literal of a bound item then', () => {
    const odd: StoredAnswer = { blocks: [{ kind: 'sentences', items: [{ form: 'unbound', text: 'Jordan Lee is listed.', cites: [REF] }] }] };
    expect(sentences(presentThread(read(turn({ question: 'Q?', maskOn: true, answer: odd, sensitivityVersion: 'sv1:a' })), true, 'sv1:a'))).toEqual([{ state: 'withheld' }]);
    const refusal: StoredAnswer = { blocks: [{ kind: 'refusal', sentence: { form: 'frozen', text: 'A fixed refusal.' }, overview: [{ form: 'unbound', text: 'Jordan Lee is in view.', cites: [REF] }] }] };
    const shown = presentThread(read(turn({ question: 'Q?', maskOn: false, answer: refusal, sensitivityVersion: 'sv1:a' })), true, 'sv1:old');
    expect(JSON.stringify(shown)).not.toMatch(/Jordan|A fixed refusal/u);
    expect(shown.turns[0]?.answer?.blocks[0]).toEqual({ kind: 'refusal', sentence: { state: 'withheld' }, overview: [{ item: { state: 'withheld' }, cites: [REF] }] });
    const label: StoredAnswer = { blocks: [{ kind: 'table', columns: [{ form: 'unbound', text: 'Jordan Lee' }], rows: [{ cells: [{ form: 'frozen', text: 'x' }], cites: [REF] }] }] };
    const labelled = presentThread(read(turn({ question: 'Q?', maskOn: false, answer: label, sensitivityVersion: 'sv1:a' })), true, 'sv1:a');
    expect(JSON.stringify(labelled)).not.toContain('Jordan');
    const literal: StoredAnswer = { blocks: [{ kind: 'sentences', items: [{ form: 'bound', segments: [{ literal: 'Newly sensitive words ' }, { element: REF, property: 'holder' }], cites: [REF] }] }] };
    expect(JSON.stringify(presentThread(read(turn({ question: 'Q?', maskOn: false, answer: literal, sensitivityVersion: 'sv1:a' })), true, 'sv1:other'))).not.toContain('Newly sensitive');
  });
});
