import { describe, expect, it } from 'vitest';
import { ASSISTANT_REFUSAL_CAUSES, ASSISTANT_REFUSAL_SENTENCES, ASSISTANT_VIEW_KEYS_MAX, assistantTurnAnswerSchema, assistantTurnRequestSchema } from './assistant-turn.js';

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

  it('is published as two forms that each require one of the members, so a client reading the schema alone refuses both and neither', async () => {
    const { buildOpenApiDocument } = await import('./openapi.js');
    const schema = buildOpenApiDocument().components.schemas.AssistantTurnRequest;
    const forms = (schema['anyOf'] ?? schema['oneOf']) as readonly { required?: readonly string[]; additionalProperties?: unknown }[];
    expect(forms).toHaveLength(2);
    expect(forms.map((form) => form.required?.filter((name) => name === 'message' || name === 'continue'))).toEqual([['message'], ['continue']]);
    expect(forms.every((form) => form.additionalProperties === false)).toBe(true);
  });
});

describe('the assistant turn answer: the view route', () => {
  const ref = { sourceId: 'demo', entityType: 'widget', stableId: 'W-1' };
  const view = { status: 'answered', route: 'view', sentences: [{ text: 'Widget W-1 is here.', cites: ['n1'] }], citations: [{ key: 'n1', kind: 'entity', ref }], coverage: { retrieval: '1 shown · 0 not yet retrieved (exact)', summary: 'The draft cites 1 of the 1 shown elements.' }, model: 'claude-sonnet-5-5', calls: 2 };

  it('accepts sentences with the citations they name, the model and the calls', () => {
    expect(assistantTurnAnswerSchema.safeParse(view).success).toBe(true);
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
