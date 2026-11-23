import { describe, expect, it } from 'vitest';
import { combineOutcomes } from './answer-blocks.js';
import type { AnswerBasis, ToolAnswerOutcome } from './tool-answer.js';

type Judged = Extract<ToolAnswerOutcome, { kind: 'sentences' | 'table' }>;
const ELEMENT = { key: 'n1', kind: 'entity' as const, ref: { sourceId: 'a', entityType: 't', stableId: 'e1' } };
const READ = { key: 's1', kind: 'read' as const, label: 'a read', finding: 'found nothing' };
const BASIS = { assembled: { keys: new Map([['n1', {}], ['n2', {}]]) } } as unknown as AnswerBasis;
const COVERAGE = { retrieval: '1 shown · exact', summary: '1 of 1 shown · exact' };

describe('the answer of several blocks', () => {
  it('counts the elements the answer cites, not the read lines or the descriptions it cites', () => {
    const sentences = { kind: 'sentences', sentences: [{ text: 'A read found nothing.', cites: ['s1'] }, { text: 'One element is listed.', cites: ['n1'] }], citations: [READ, ELEMENT], coverage: COVERAGE, model: 'm', calls: 1 } as unknown as Judged;
    const combined = combineOutcomes([sentences], BASIS);
    expect(combined?.citations.map((citation) => citation.key)).toEqual(['s1', 'n1']);
    expect(combined?.coverage.summary).toBe('The answer cites 1 of the 2 elements the reads returned.');
  });
});
