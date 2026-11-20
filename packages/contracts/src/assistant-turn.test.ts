import { describe, expect, it } from 'vitest';
import { ASSISTANT_CHOICE_INVALID_SENTENCE, ASSISTANT_CLARIFICATION_MAX_CANDIDATES, ASSISTANT_CONFIRMATION_INVALID_SENTENCE, ASSISTANT_LIMITS, ASSISTANT_LIMIT_SENTENCES, ASSISTANT_PLAN_MAX_CHARACTERS, ASSISTANT_REFUSAL_CAUSES, ASSISTANT_REFUSAL_SENTENCES, ASSISTANT_SUMMARY_INVALID_SENTENCE, ASSISTANT_VIEW_KEYS_MAX, assistantClarificationQuestion, assistantTurnAnswerSchema, assistantTurnRequestSchema } from './assistant-turn.js';

const body = { sourceId: 'banking', investigationId: 'inv-1', message: 'Which accounts share a device?', viewElementKeys: ['n1', 'n2'] };

describe('the assistant turn request', () => {
  it('accepts a message with the keys of the view and an optional mask', () => {
    expect(assistantTurnRequestSchema.safeParse(body).success).toBe(true);
    expect(assistantTurnRequestSchema.safeParse({ ...body, mask: true }).success).toBe(true);
  });

  it('refuses an unknown member, an empty message and a missing member', () => {
    expect(assistantTurnRequestSchema.safeParse({ ...body, extra: 1 }).success).toBe(false);
    expect(assistantTurnRequestSchema.safeParse({ ...body, message: '' }).success).toBe(false);
    expect(assistantTurnRequestSchema.safeParse({ sourceId: 'banking', investigationId: 'inv-1', message: 'hi' }).success).toBe(false);
    expect(assistantTurnRequestSchema.safeParse({ ...body, investigationId: '' }).success).toBe(false);
  });

  it('accepts 300 keys and refuses 301', () => {
    const keys = (count: number): string[] => Array.from({ length: count }, (_, index) => `k${index}`);
    expect(ASSISTANT_VIEW_KEYS_MAX).toBe(300);
    expect(assistantTurnRequestSchema.safeParse({ ...body, viewElementKeys: keys(300) }).success).toBe(true);
    expect(assistantTurnRequestSchema.safeParse({ ...body, viewElementKeys: keys(301) }).success).toBe(false);
  });
});

describe('the assistant turn request: a message or a continue', () => {
  const asked = { intent: 'shared-devices', entities: { id: 'A-1' }, continueToken: `${'1'.repeat(10)}.${'a'.repeat(64)}` };
  const base = { sourceId: 'banking', investigationId: 'inv-1', viewElementKeys: [] };

  it('accepts a continue without a message and refuses both, neither and a continue with a bad token', () => {
    expect(assistantTurnRequestSchema.safeParse({ ...base, continue: asked }).success).toBe(true);
    expect(assistantTurnRequestSchema.safeParse({ ...base, continue: asked, message: 'x' }).success).toBe(false);
    expect(assistantTurnRequestSchema.safeParse(base).success).toBe(false);
    expect(assistantTurnRequestSchema.safeParse({ ...base, continue: { ...asked, continueToken: 'nope' } }).success).toBe(false);
  });

  it('is published as four forms that each require one of the members, so a client reading the schema alone refuses all and none', async () => {
    const { buildOpenApiDocument } = await import('./openapi.js');
    const schema = buildOpenApiDocument().components.schemas.AssistantTurnRequest;
    const forms = (schema['anyOf'] ?? schema['oneOf']) as readonly { required?: readonly string[]; additionalProperties?: unknown }[];
    expect(forms).toHaveLength(4);
    expect(forms.map((form) => form.required?.filter((name) => name === 'message' || name === 'continue' || name === 'choice' || name === 'confirmation'))).toEqual([['message'], ['message', 'confirmation'], ['continue'], ['choice']]);
    expect(forms.every((form) => form.additionalProperties === false)).toBe(true);
  });
});

describe('the assistant turn answer: the view route', () => {
  const ref = { sourceId: 'demo', entityType: 'widget', stableId: 'W-1' };
  const view = { status: 'answered', route: 'view', sentences: [{ text: 'Widget W-1 is here.', cites: ['n1'] }], citations: [{ key: 'n1', kind: 'entity', ref }], coverage: { retrieval: '1 shown · 0 not yet retrieved (exact)', summary: 'The draft cites 1 of the 1 shown elements.' }, model: 'claude-sonnet-5-5', calls: 2 };

  it('accepts sentences with the citations they name, the model and the calls', () => {
    expect(assistantTurnAnswerSchema.safeParse(view).success).toBe(true);
  });

  it('accepts the answer meaning with described types, a fixed sentence or both, and refuses one that says nothing or holds an extra member', () => {
    const described = [{ typeKind: 'entity', type: 'Widget', description: 'A widget is a unit.' }];
    const fixed = { sentence: 'The mapping has no description for Gizmo, so I cannot say what it means.', names: ['Gizmo'] };
    expect(assistantTurnAnswerSchema.safeParse({ status: 'meaning', described }).success).toBe(true);
    expect(assistantTurnAnswerSchema.safeParse({ status: 'meaning', described: [], noDescription: fixed }).success).toBe(true);
    expect(assistantTurnAnswerSchema.safeParse({ status: 'meaning', described, noDescription: fixed }).success).toBe(true);
    expect(assistantTurnAnswerSchema.safeParse({ status: 'meaning', described: [] }).success).toBe(false);
    expect(assistantTurnAnswerSchema.safeParse({ status: 'meaning', described, route: 'view' }).success).toBe(false);
    expect(assistantTurnAnswerSchema.safeParse({ status: 'meaning', described: [{ ...described[0], description: 'x'.repeat(301) }] }).success).toBe(false);
  });

  it('accepts the answer no-description and the member noDescription, and refuses an empty list of names or an extra member', () => {
    const none = { status: 'no-description', route: 'view', sentence: 'The mapping has no description for Gizmo, so I cannot say what it means.', names: ['Gizmo'] };
    expect(assistantTurnAnswerSchema.safeParse(none).success).toBe(true);
    expect(assistantTurnAnswerSchema.safeParse({ ...none, names: [] }).success).toBe(false);
    expect(assistantTurnAnswerSchema.safeParse({ ...none, cites: [] }).success).toBe(false);
    expect(assistantTurnAnswerSchema.safeParse({ ...view, noDescription: 'The mapping has no description for Gizmo, so I cannot say what it means.' }).success).toBe(true);
  });

  it('accepts a citation of a meaning line, alone or beside an element, and refuses one with a member it does not have', () => {
    const description = { key: 'm1', kind: 'description', typeKind: 'entity', type: 'Widget', description: 'A widget is a small unit.' };
    expect(assistantTurnAnswerSchema.safeParse({ ...view, sentences: [{ text: 'A widget is a small unit.', cites: ['m1'] }], citations: [description] }).success).toBe(true);
    expect(assistantTurnAnswerSchema.safeParse({ ...view, citations: [...view.citations, description] }).success).toBe(true);
    expect(assistantTurnAnswerSchema.safeParse({ ...view, citations: [{ ...description, ref }] }).success).toBe(false);
    expect(assistantTurnAnswerSchema.safeParse({ ...view, citations: [{ ...description, description: 'x'.repeat(301) }] }).success).toBe(false);
  });

  it('refuses no sentence, more than 12, no citation, a citation of no known form and an unknown member', () => {
    expect(assistantTurnAnswerSchema.safeParse({ ...view, sentences: [] }).success).toBe(false);
    expect(assistantTurnAnswerSchema.safeParse({ ...view, sentences: Array.from({ length: 13 }, () => view.sentences[0]) }).success).toBe(false);
    expect(assistantTurnAnswerSchema.safeParse({ ...view, citations: [] }).success).toBe(false);
    expect(assistantTurnAnswerSchema.safeParse({ ...view, citations: [{ key: 'n1', kind: 'entity', ref: { nope: 1 } }] }).success).toBe(false);
    expect(assistantTurnAnswerSchema.safeParse({ ...view, extra: 1 }).success).toBe(false);
    expect(assistantTurnAnswerSchema.safeParse({ ...view, calls: 0 }).success).toBe(false);
  });
});

describe('the assistant turn answer: failures', () => {
  it('accepts unavailable of each kind with readStarted, a wait only when given, too-large and too-long', () => {
    for (const kind of ['service', 'timeout', 'rate-limit'] as const) expect(assistantTurnAnswerSchema.safeParse({ status: 'unavailable', kind, readStarted: false }).success).toBe(true);
    expect(assistantTurnAnswerSchema.safeParse({ status: 'unavailable', kind: 'rate-limit', readStarted: true, retryAfterSeconds: 30 }).success).toBe(true);
    expect(assistantTurnAnswerSchema.safeParse({ status: 'unavailable', kind: 'service' }).success).toBe(false);
    expect(assistantTurnAnswerSchema.safeParse({ status: 'too-large', sentence: 'x' }).success).toBe(true);
    expect(assistantTurnAnswerSchema.safeParse({ status: 'too-long', words: 1243, limit: 1000 }).success).toBe(true);
  });
});

describe('the assistant turn answer', () => {
  it('accepts a refusal of each cause with its fixed sentence', () => {
    for (const cause of ASSISTANT_REFUSAL_CAUSES) {
      expect(assistantTurnAnswerSchema.safeParse({ status: 'answered', route: 'refuse', cause, sentence: ASSISTANT_REFUSAL_SENTENCES[cause] }).success).toBe(true);
    }
  });

  it('accepts the not-answered turn of the view route', () => {
    expect(assistantTurnAnswerSchema.safeParse({ status: 'not-answered', route: 'view', sentence: 'x' }).success).toBe(true);
  });

  it('refuses a member outside the union, an unknown cause and a refusal carrying a result', () => {
    expect(assistantTurnAnswerSchema.safeParse({ status: 'answered', route: 'view', sentence: 'x' }).success).toBe(false);
    expect(assistantTurnAnswerSchema.safeParse({ status: 'unavailable', kind: 'oops', readStarted: false }).success).toBe(false);
    expect(assistantTurnAnswerSchema.safeParse({ status: 'too-long', words: 0, limit: 1000 }).success).toBe(false);
    expect(assistantTurnAnswerSchema.safeParse({ status: 'answered', route: 'refuse', cause: 'guilty', sentence: 'x' }).success).toBe(false);
    expect(assistantTurnAnswerSchema.safeParse({ status: 'answered', route: 'refuse', cause: 'verdict', sentence: 'x', result: {} }).success).toBe(false);
    expect(assistantTurnAnswerSchema.safeParse({ status: 'answered', route: 'refuse', cause: 'verdict' }).success).toBe(false);
  });
});

describe('the fixed sentences of a refusal', () => {
  it('are the four agreed sentences, none of which holds a value of the message or a word of the model', () => {
    expect(ASSISTANT_REFUSAL_SENTENCES).toEqual({
      verdict: 'I can’t judge guilt or intent. I can show what the investigation connects.',
      'raw-query': 'I can’t take query text. Describe what you want to see in plain words.',
      'other-source': 'I can only work with the source of this investigation.',
      unplaced: 'I can’t place this message. Rephrase it, or use the manual tools.',
    });
  });
});

const TOKEN = `${'1'.repeat(10)}.${'a'.repeat(64)}`;
const choiceFor = (stableId: string) => ({ intent: 'shared', roles: ['id'], entities: { id: stableId }, choiceToken: TOKEN });

describe('the clarification of an assistant turn', () => {
  const candidate = { title: 'W-884', type: 'Widget', choice: choiceFor('W-884') };
  const clarification = { status: 'clarification', question: 'Which widget do you mean?', candidates: [candidate, { title: 'W-217', type: 'Widget', choice: choiceFor('W-217') }] };

  it('accepts the question with one to the most candidates, each a title and an entity type name', () => {
    expect(assistantTurnAnswerSchema.safeParse(clarification).success).toBe(true);
    expect(assistantTurnAnswerSchema.safeParse({ ...clarification, candidates: [candidate] }).success).toBe(true);
    expect(assistantTurnAnswerSchema.safeParse({ ...clarification, candidates: Array.from({ length: ASSISTANT_CLARIFICATION_MAX_CANDIDATES }, () => candidate) }).success).toBe(true);
  });

  it.each([
    ['no candidate', { candidates: [] }],
    ['more candidates than the most', { candidates: Array.from({ length: ASSISTANT_CLARIFICATION_MAX_CANDIDATES + 1 }, () => candidate) }],
    ['a candidate with a key or a reference', { candidates: [{ ...candidate, key: 'c1' }] }],
    ['a candidate with no type', { candidates: [{ title: 'W-884', choice: choiceFor('W-884') }] }],
    ['a candidate with no choice', { candidates: [{ title: 'W-884', type: 'Widget' }] }],
    ['a candidate whose choice has a token of another form', { candidates: [{ ...candidate, choice: { ...choiceFor('W-884'), choiceToken: 'abc' } }] }],
    ['an empty question', { question: '' }],
    ['a member of another form', { route: 'ask' }],
  ])('refuses %s', (_name, over) => {
    expect(assistantTurnAnswerSchema.safeParse({ ...clarification, ...over }).success).toBe(false);
  });

  it('writes the question with the entity type name, in lower case only for a plain capitalised word', () => {
    expect(assistantClarificationQuestion('Widget')).toBe('Which widget do you mean?');
    expect(assistantClarificationQuestion('IP address')).toBe('Which IP address do you mean?');
    expect(assistantClarificationQuestion('widget')).toBe('Which widget do you mean?');
  });
});

describe('the choice of an assistant turn', () => {
  const base = { sourceId: 'banking', investigationId: 'inv-1', viewElementKeys: [] };

  it('is a third form of the request: the intent, the role, the entities and the token, never with a message or a continue', () => {
    expect(assistantTurnRequestSchema.safeParse({ ...base, choice: choiceFor('W-884') }).success).toBe(true);
    expect(assistantTurnRequestSchema.safeParse({ ...base, mask: true, choice: choiceFor('W-884') }).success).toBe(true);
    expect(assistantTurnRequestSchema.safeParse({ ...base, message: 'hi', choice: choiceFor('W-884') }).success).toBe(false);
  });

  it.each([
    ['no token', { intent: 'shared', roles: ['id'], entities: { id: 'W-1' } }],
    ['a token of another form', { ...choiceFor('W-1'), choiceToken: 'abc' }],
    ['no roles', { intent: 'shared', entities: { id: 'W-1' }, choiceToken: TOKEN }],
    ['a member that is not in the form', { ...choiceFor('W-1'), extra: 1 }],
    ['an intent that is not a name', { ...choiceFor('W-1'), intent: '1; DROP' }],
  ])('refuses a choice with %s', (_name, choice) => {
    expect(assistantTurnRequestSchema.safeParse({ ...base, choice }).success).toBe(false);
  });

  it('answers a choice that is not valid with its fixed sentence', () => {
    expect(assistantTurnAnswerSchema.safeParse({ status: 'choice-invalid', sentence: ASSISTANT_CHOICE_INVALID_SENTENCE }).success).toBe(true);
    expect(ASSISTANT_CHOICE_INVALID_SENTENCE).toBe('This choice is no longer valid. Nothing was read.');
  });
});

describe('the limit status of a turn', () => {
  const read = { tool: 'a', kind: 'intent', read: true, rows: 1, quality: 'exact', partial: false };

  it.each(ASSISTANT_LIMITS)('accepts the %s limit with its own fixed sentence and the reads made, and nothing else', (limit) => {
    const answer = { status: 'limit', limit, sentence: ASSISTANT_LIMIT_SENTENCES[limit], reads: [read] };
    expect(assistantTurnAnswerSchema.safeParse(answer).success).toBe(true);
    expect(assistantTurnAnswerSchema.safeParse({ ...answer, reads: [] }).success).toBe(true);
    expect(assistantTurnAnswerSchema.safeParse({ ...answer, extra: 1 }).success).toBe(false);
  });

  it('refuses a limit that is not one of the five, and a limit without its sentence or its reads', () => {
    expect(assistantTurnAnswerSchema.safeParse({ status: 'limit', limit: 'tokens', sentence: 'x', reads: [] }).success).toBe(false);
    expect(assistantTurnAnswerSchema.safeParse({ status: 'limit', limit: 'calls', reads: [] }).success).toBe(false);
    expect(assistantTurnAnswerSchema.safeParse({ status: 'limit', limit: 'calls', sentence: 'x' }).success).toBe(false);
  });

  it('has a different sentence for each limit, none with a digit or a value in it, each pointing at what was read above', () => {
    expect(new Set(Object.values(ASSISTANT_LIMIT_SENTENCES)).size).toBe(ASSISTANT_LIMITS.length);
    for (const sentence of Object.values(ASSISTANT_LIMIT_SENTENCES)) {
      expect(sentence).not.toMatch(/\d/);
      expect(sentence).toMatch(/What was read is shown above\.$/);
    }
    expect(ASSISTANT_LIMIT_SENTENCES.time).toBe('This turn ran out of time, so it stopped. What was read is shown above.');
  });

  it('lets a citation of an answer after tool steps carry the title of the element as the result gave it, and no other member', () => {
    const answer = { status: 'answered', route: 'ask', sentences: [{ text: 'Account A-1 is listed.', cites: ['r1'] }], coverage: { retrieval: 'x', summary: 'y' }, model: 'm', calls: 4, steps: 2, reads: [read, read] };
    const cite = { key: 'r1', kind: 'entity', ref: { sourceId: 'banking', entityType: 'widget', stableId: 'A-1' } };
    expect(assistantTurnAnswerSchema.safeParse({ ...answer, citations: [{ ...cite, title: 'Account A-1' }] }).success).toBe(true);
    expect(assistantTurnAnswerSchema.safeParse({ ...answer, citations: [{ ...cite, title: '' }] }).success).toBe(false);
    expect(assistantTurnAnswerSchema.safeParse({ ...answer, citations: [{ ...cite, label: 'x' }] }).success).toBe(false);
  });

  it('names the limit that ended the reading of an answered turn, in the answer after tool steps and in Ask’s single read, and no other value', () => {
    const answer = { status: 'answered', route: 'ask', sentences: [{ text: 'Account A-1 is listed.', cites: ['s1'] }], citations: [], coverage: { retrieval: 'x', summary: 'y' }, model: 'm', calls: 4, steps: 2, reads: [read, read] };
    expect(assistantTurnAnswerSchema.safeParse({ ...answer, stoppedAt: 'rows' }).success).toBe(true);
    expect(assistantTurnAnswerSchema.safeParse({ ...answer, stoppedAt: 'tokens' }).success).toBe(false);
  });
});

describe('the answer of the ask route after tool steps', () => {
  const ref = { sourceId: 'banking', entityType: 'widget', stableId: 'A-1' };
  const answer = { status: 'answered', route: 'ask', sentences: [{ text: 'Account A-1 is listed.', cites: ['n1'] }], citations: [{ key: 'n1', kind: 'entity', ref }], coverage: { retrieval: '2 shown', summary: 'The answer cites 1 of the 2 elements the reads returned.' }, model: 'm', calls: 4, steps: 2, reads: [{ tool: 'a', kind: 'intent', read: true, rows: 1, quality: 'exact', partial: false }, { tool: 'b', kind: 'template', read: false }] };

  it('accepts the sentences with their citations, the coverage, the model, the calls and at least two steps', () => {
    expect(assistantTurnAnswerSchema.safeParse(answer).success).toBe(true);
    expect(assistantTurnAnswerSchema.safeParse({ ...answer, reads: [] }).success).toBe(false);
  });

  it('accepts no citation of an element (a sentence may cite the line of a read only), and refuses one step, no sentence, an extra member, and the answer of Ask together with the sentences', () => {
    expect(assistantTurnAnswerSchema.safeParse({ ...answer, steps: 1 }).success).toBe(false);
    expect(assistantTurnAnswerSchema.safeParse({ ...answer, sentences: [] }).success).toBe(false);
    expect(assistantTurnAnswerSchema.safeParse({ ...answer, citations: [] }).success).toBe(true);
    expect(assistantTurnAnswerSchema.safeParse({ ...answer, extra: 1 }).success).toBe(false);
    expect(assistantTurnAnswerSchema.safeParse({ ...answer, answer: { refused: { cause: 'no-intent', sentence: 'x' } } }).success).toBe(false);
  });
});

describe('the summary an assistant turn carries', () => {
  const base = { sourceId: 'a', investigationId: 'i', viewElementKeys: [] };
  const TOKEN = 'v1.cur00001.aaaa.bbbb.cccc';

  it('is carried by the message form only: the choice and continue forms refuse it', () => {
    expect(assistantTurnRequestSchema.safeParse({ ...base, message: 'x', summaryToken: TOKEN }).success).toBe(true);
    expect(assistantTurnRequestSchema.safeParse({ ...base, message: 'x', summaryToken: '' }).success).toBe(false);
    expect(assistantTurnRequestSchema.safeParse({ ...base, continue: { intent: 'i', entities: {}, continueToken: `${'1'.repeat(10)}.${'a'.repeat(64)}` }, summaryToken: TOKEN }).success).toBe(false);
    expect(assistantTurnRequestSchema.safeParse({ ...base, choice: { intent: 'i', roles: ['id'], entities: { id: 'x' }, choiceToken: `${'1'.repeat(10)}.${'a'.repeat(64)}` }, summaryToken: TOKEN }).success).toBe(false);
  });

  it('answers a summary that cannot be used with its fixed sentence and nothing else', () => {
    expect(ASSISTANT_SUMMARY_INVALID_SENTENCE).toBe('This summary can no longer be used. Generate it again.');
    expect(assistantTurnAnswerSchema.safeParse({ status: 'summary-invalid', sentence: ASSISTANT_SUMMARY_INVALID_SENTENCE }).success).toBe(true);
    expect(assistantTurnAnswerSchema.safeParse({ status: 'summary-invalid', sentence: ASSISTANT_SUMMARY_INVALID_SENTENCE, cause: 'expired' }).success).toBe(false);
  });
});

describe('the view answer that rests on a summary', () => {
  const view = { status: 'answered', route: 'view', sentences: [{ text: 'x', cites: ['n1'] }], citations: [{ key: 'n1', kind: 'entity', ref: { sourceId: 'a', entityType: 'k', stableId: 's' } }], coverage: { retrieval: '1 shown', summary: 'The draft cites 1 of the 1 shown elements.' }, model: 'm', calls: 2 };

  it('carries the positions of the summary sentences it cites and the line that says so, each only when there are some', () => {
    expect(assistantTurnAnswerSchema.safeParse(view).success).toBe(true);
    expect(assistantTurnAnswerSchema.safeParse({ ...view, summarySentencesCited: [1, 3], coverage: { ...view.coverage, summaryCited: "Cites the summary's sentences 1 and 3." } }).success).toBe(true);
    expect(assistantTurnAnswerSchema.safeParse({ ...view, summarySentencesCited: [] }).success).toBe(false);
    expect(assistantTurnAnswerSchema.safeParse({ ...view, summarySentencesCited: [0] }).success).toBe(false);
    expect(assistantTurnAnswerSchema.safeParse({ ...view, summarySentencesCited: [13] }).success).toBe(false);
  });
});

describe('the confirmation of a heavy step', () => {
  const plan = `${'1'.repeat(10)}.${'a'.repeat(200)}.${'b'.repeat(64)}`;
  const pendingId = '0192f000-0000-7000-8000-0000000000a1';
  const base = { sourceId: 'banking', investigationId: 'inv-1', viewElementKeys: ['n1'] };
  const waiting = { status: 'confirmation', pendingId, plan, step: { tool: 'shared', kind: 'intent', subject: 'A-9', count: { quality: 'lowerBound', value: 1000 }, page: 25 }, reads: [{ tool: 'a', kind: 'intent', read: true, rows: 1, quality: 'exact', partial: false }] };

  it('accepts the waiting answer with the pending id, the plan, what the step would read and the reads so far, and nothing else', () => {
    expect(assistantTurnAnswerSchema.safeParse(waiting).success).toBe(true);
    expect(assistantTurnAnswerSchema.safeParse({ ...waiting, extra: 1 }).success).toBe(false);
    expect(assistantTurnAnswerSchema.safeParse({ ...waiting, continueToken: `${'1'.repeat(10)}.${'a'.repeat(64)}` }).success).toBe(false);
    expect(assistantTurnAnswerSchema.safeParse({ ...waiting, step: { ...waiting.step, page: 0 } }).success).toBe(false);
    expect(assistantTurnAnswerSchema.safeParse({ ...waiting, plan: 'not a plan' }).success).toBe(false);
    expect(assistantTurnAnswerSchema.safeParse({ ...waiting, plan: `${'1'.repeat(10)}.${'a'.repeat(ASSISTANT_PLAN_MAX_CHARACTERS)}.${'b'.repeat(64)}` }).success).toBe(false);
  });

  it('takes the decision as a form of its own, with the message and the view, and as no other form', () => {
    const form = { ...base, message: 'who else?', confirmation: { pendingId, plan, decision: 'confirm' } };
    expect(assistantTurnRequestSchema.safeParse(form).success).toBe(true);
    for (const decision of ['skip', 'cancel']) expect(assistantTurnRequestSchema.safeParse({ ...form, confirmation: { ...form.confirmation, decision } }).success).toBe(true);
    for (const bad of [{ ...form, confirmation: { ...form.confirmation, decision: 'run' } }, { ...form, confirmation: { ...form.confirmation, pendingId: 'x' } }, { ...form, confirmation: { ...form.confirmation, extra: 1 } }, { ...form, continue: { intent: 'a', entities: {}, continueToken: `${'1'.repeat(10)}.${'a'.repeat(64)}` } }, { ...base, confirmation: form.confirmation }]) {
      expect(assistantTurnRequestSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('answers a decision that is no longer valid with its fixed sentence, and a cancel with nothing more', () => {
    expect(assistantTurnAnswerSchema.safeParse({ status: 'confirmation-invalid', sentence: ASSISTANT_CONFIRMATION_INVALID_SENTENCE }).success).toBe(true);
    expect(ASSISTANT_CONFIRMATION_INVALID_SENTENCE).toBe('This confirmation is no longer valid. Nothing was read.');
    expect(assistantTurnAnswerSchema.safeParse({ status: 'cancelled' }).success).toBe(true);
    expect(assistantTurnAnswerSchema.safeParse({ status: 'cancelled', extra: 1 }).success).toBe(false);
  });
});

