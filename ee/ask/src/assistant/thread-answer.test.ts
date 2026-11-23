import type { AssistantTurnAnswer } from '@neburyx/contracts';
import { assistantThreadTurnWriteSchema } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { storedAnswerOf } from './thread-answer.js';

const REF = { sourceId: 'demo', entityType: 'widget', stableId: 'A-1' };
const citation = { key: 'n1', kind: 'entity', ref: REF } as const;
const base = { id: crypto.randomUUID(), investigationId: crypto.randomUUID(), userId: crypto.randomUUID(), at: new Date(), route: 'view', outcome: 'answered', questionHash: 'a'.repeat(64), entities: [], citationRefs: [], steps: 0, maskOn: false } as const;
const viewAnswer = (over: Record<string, unknown>): AssistantTurnAnswer => ({ status: 'answered', route: 'view', citations: [citation], coverage: { retrieval: 'x', summary: 'y' }, model: 'm', calls: 1, ...over }) as AssistantTurnAnswer;
const written = (answer: AssistantTurnAnswer, maskOn: boolean) => assistantThreadTurnWriteSchema.parse({ ...base, maskOn, question: 'Q?', answer: storedAnswerOf(answer, maskOn) });

describe('the stored form of an answer', () => {
  it('keeps a table with an empty cell, each column and each cell in the form of the mask state, and the fixed server lines in a block of their own', () => {
    const answer = viewAnswer({ table: { title: 'T', columns: ['Name', 'Note'], rows: [{ cells: ['Ana', ''], cites: ['n1'] }] }, pointer: 'A fixed pointer sentence.', noDescription: 'A fixed description sentence.', lastCallNote: 'A fixed note.' });
    for (const [maskOn, form] of [[false, 'unbound'], [true, 'frozen']] as const) {
      const stored = written(answer, maskOn).answer;
      expect(stored?.blocks[0]).toEqual({ kind: 'table', columns: [{ form, text: 'Name' }, { form, text: 'Note' }], rows: [{ cells: [{ form, text: 'Ana' }, { form, text: '' }], cites: [REF] }] });
      expect(stored?.blocks[1]).toEqual({ kind: 'sentences', items: [{ form: 'frozen', text: 'A fixed description sentence.', cites: [] }, { form: 'frozen', text: 'A fixed pointer sentence.', cites: [] }, { form: 'frozen', text: 'A fixed note.', cites: [] }] });
    }
  });

  it('keeps twelve sentences of the model and the three fixed lines, cutting nothing', () => {
    const sentences = Array.from({ length: 12 }, (_, index) => ({ text: `Sentence ${index + 1}.`, cites: ['n1'] }));
    const stored = written(viewAnswer({ sentences, pointer: 'P.', noDescription: 'N.', lastCallNote: 'L.' }), false).answer;
    expect(stored?.blocks.flatMap((block) => (block.kind === 'sentences' ? block.items : []))).toHaveLength(15);
  });

  it('keeps a value as the answer shows it: written with the mask on, the masked text is stored frozen, and nothing else of the element', () => {
    const stored = written(viewAnswer({ sentences: [{ text: 'The holder is ******* here.', cites: ['n1'] }] }), true);
    expect(JSON.stringify(stored.answer)).not.toContain('Ana Silva');
    expect(stored.answer?.blocks[0]).toMatchObject({ kind: 'sentences', items: [{ form: 'frozen', text: 'The holder is ******* here.' }] });
  });

  it('keeps the fixed sentences of a refusal frozen when the mask is off, and gives no form to an answer that has none yet', () => {
    const refusal = { status: 'answered', route: 'refuse', cause: 'verdict', sentence: 'A fixed refusal.' } as AssistantTurnAnswer;
    expect(storedAnswerOf(refusal, false)?.blocks[0]).toEqual({ kind: 'refusal', sentence: { form: 'frozen', text: 'A fixed refusal.' } });
    expect(storedAnswerOf({ status: 'cancelled' } as AssistantTurnAnswer, false)).toBeUndefined();
  });
});
