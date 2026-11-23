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

  it('keeps the count of the earlier turns and the clearing', () => {
    expect(presentThread({ turns: [], earlierTurns: 4, previousThreadClearedAt: '2026-11-18T10:00:00.000Z' }, false, undefined)).toEqual({ turns: [], earlierTurns: 4, previousThreadClearedAt: '2026-11-18T10:00:00.000Z' });
  });
});
