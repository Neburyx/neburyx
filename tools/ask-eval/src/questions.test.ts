import { describe, expect, it } from 'vitest';
import { parseQuestions, QuestionFileError } from './questions.js';

const ENTRY = `  - id: show-one
    wording: Show me ‹widget#1›.
    expect: { kind: plan, template: entity, params: { ref: { entityType: widget, stableId: ‹widget#1› } } }
`;
const file = (body: string): string => `questions:\n${body}`;
const refused = (text: string): string => {
  try {
    parseQuestions(text);
  } catch (error) {
    if (error instanceof QuestionFileError) return error.message;
    throw error;
  }
  return 'accepted';
};

describe('loading a question file', () => {
  it('accepts a plan, a refusal with a known family and a blocked question', () => {
    const questions = parseQuestions(file(`${ENTRY}  - id: refuse-one\n    wording: Is ‹widget#1› fraudulent?\n    expect: { kind: unsupported, family: judgement }\n  - id: blocked-one\n    wording: Odd text.\n    expect: { kind: blocked }\n`));
    expect(questions.map((question) => question.expect.kind)).toEqual(['plan', 'unsupported', 'blocked']);
  });

  it.each([
    ['a duplicate id', file(ENTRY + ENTRY), 'show-one is used twice'],
    ['an unknown template', file(ENTRY.replace('template: entity', 'template: free-query')), 'malformed at'],
    ['an unknown key', file(ENTRY.replace('wording:', 'note: x\n    wording:')), 'malformed at'],
    ['a plan without a template', file(ENTRY.replace('template: entity, ', '')), 'malformed at'],
    ['an unknown family', file(`  - id: refuse-one\n    wording: Is ‹widget#1› fraudulent?\n    expect: { kind: unsupported, family: made-up }\n`), 'malformed at'],
    ['parameters that do not fit the template', file(ENTRY.replace('params: { ref: { entityType: widget, stableId: ‹widget#1› } }', 'params: { query: x }')), 'does not fit its template'],
    ['text that is not YAML', 'questions: [', 'not valid YAML'],
  ])('refuses %s with an error that names no wording', (_name, text, reason) => {
    const message = refused(text);
    expect(message).toContain(reason);
    expect(message).not.toContain('Show me');
  });
});
