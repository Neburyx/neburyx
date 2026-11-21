import { Ajv } from 'ajv';
import { ASK_ENTITY_TEXT_MAX_LENGTH, ASK_FOLDER_LIMITS, ASK_SAVED_PATTERN_INTENT, readClassification } from '@neburyx/contracts';
import { readAssistantRoute } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { classificationSchema, routerSchema, schemasOf, summarySchema } from './local-schemas.js';

const ajv = new Ajv({ strict: true, allErrors: false });
const validates = (schema: object) => ajv.compile(schema);

const manyEntities = (count: number): Record<string, string> => Object.fromEntries(Array.from({ length: count }, (_, index) => [`role${index}`, 'v']));

const ROUTES_THE_READER_ACCEPTS: readonly (readonly [string, unknown])[] = [
  ['view', { route: 'view' }],
  ['view with types and the table form', { route: 'view', types: ['Thing', 'Tie'], form: 'table' }],
  ['meaning', { route: 'meaning', types: ['Thing'] }],
  ['refuse', { route: 'refuse', cause: 'verdict' }],
  ['refuse unplaced', { route: 'refuse', cause: 'unplaced' }],
  ['ask', { route: 'ask', intent: 'a-b_c', entities: { subject: 'S-1' } }],
  ['ask with no entity', { route: 'ask', intent: 'x', entities: {} }],
  ['ask with elements', { route: 'ask', intent: 'x', entities: {}, elements: { subject: 'c1' } }],
  ['ask with both kinds under different roles', { route: 'ask', intent: 'x', entities: { a: 'v' }, elements: { b: 'c12' } }],
  ['clarify', { route: 'clarify', intent: 'x', role: 'subject', entities: {}, candidates: ['c1', 'c2'] }],
  ['clarify with elements', { route: 'clarify', intent: 'x', role: 'subject', entities: { a: 'v' }, elements: { b: 'c3' }, candidates: ['c1', 'c2', 'c9'] }],
];

describe('the schema of the router reply', () => {
  const valid = validates(routerSchema());

  it.each(ROUTES_THE_READER_ACCEPTS)('accepts a reply the strict reader accepts: %s', (_name, reply) => {
    expect(readAssistantRoute(JSON.stringify(reply)).ok).toBe(true);
    expect(valid(reply), JSON.stringify(valid.errors)).toBe(true);
  });

  it.each([
    ['text around the object', 'Here you go: {"route":"view"}'],
    ['an unknown route', '{"route":"other"}'],
    ['a refuse without a cause', '{"route":"refuse"}'],
    ['an extra key', '{"route":"view","extra":1}'],
    ['an intent that is not a name', '{"route":"ask","intent":"has space","entities":{}}'],
    ['an entity that is not text', '{"route":"ask","intent":"x","entities":{"a":1}}'],
    ['a context key that is not a key', '{"route":"ask","intent":"x","entities":{},"elements":{"a":"zz"}}'],
    ['one candidate', '{"route":"clarify","intent":"x","role":"r","entities":{},"candidates":["c1"]}'],
  ])('refuses what the reader refuses where a schema can say so: %s', (_name, text) => {
    expect(readAssistantRoute(text).ok).toBe(false);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    expect(valid(parsed)).toBe(false);
  });

  it('is looser than the reader in the places the story lists, and nowhere stricter', () => {
    const looser: readonly unknown[] = [
      { route: 'ask', intent: 'x', entities: { a: 'v' }, elements: { a: 'c1' } },
      { route: 'ask', intent: 'x', entities: manyEntities(ASK_FOLDER_LIMITS.parameters), elements: { another: 'c1' } },
      { route: 'clarify', intent: 'x', role: 'subject', entities: {}, candidates: ['c1', 'c1'] },
    ];
    for (const reply of looser) {
      expect(readAssistantRoute(JSON.stringify(reply)).ok, JSON.stringify(reply)).toBe(false);
      expect(valid(reply), JSON.stringify(reply)).toBe(true);
    }
    expect(readAssistantRoute('{"route":"view","route":"view"}').ok).toBe(false);
  });

  it('gives the intent as a string of the reader\'s pattern and no enumeration', () => {
    expect(JSON.stringify(routerSchema())).not.toContain('"enum":["accounts');
    expect(valid({ route: 'ask', intent: 'an-intent-nobody-listed', entities: {} })).toBe(true);
  });

  it('allows an entity text up to the reader\'s limit and no more', () => {
    expect(valid({ route: 'ask', intent: 'x', entities: { a: 'x'.repeat(ASK_ENTITY_TEXT_MAX_LENGTH) } })).toBe(true);
    expect(valid({ route: 'ask', intent: 'x', entities: { a: 'x'.repeat(ASK_ENTITY_TEXT_MAX_LENGTH + 1) } })).toBe(false);
    expect(readAssistantRoute(JSON.stringify({ route: 'ask', intent: 'x', entities: { a: 'x'.repeat(ASK_ENTITY_TEXT_MAX_LENGTH) } })).ok).toBe(true);
  });
});

describe('the patterns the schema copies agree with the reader at their edges', () => {
  const valid = validates(routerSchema());
  const routeWith = (parts: Record<string, unknown>): unknown => ({ route: 'ask', intent: 'x', entities: {}, ...parts });
  const agree = (reply: unknown, accepted: boolean): void => {
    expect(readAssistantRoute(JSON.stringify(reply)).ok, 'the reader').toBe(accepted);
    expect(valid(reply), 'the schema').toBe(accepted);
  };

  it.each([
    ['a parameter name of 64 characters', { entities: { [`a${'b'.repeat(63)}`]: 'v' } }, true],
    ['a parameter name of 65 characters', { entities: { [`a${'b'.repeat(64)}`]: 'v' } }, false],
    ['a parameter name that starts with a digit', { entities: { '1a': 'v' } }, false],
    ['a parameter name that starts with an underscore', { entities: { _a: 'v' } }, true],
    ['an intent name of 64 characters', { intent: `a${'b'.repeat(63)}` }, true],
    ['an intent name of 65 characters', { intent: `a${'b'.repeat(64)}` }, false],
    ['a context key c9999', { elements: { role: 'c9999' } }, true],
    ['a context key c10000', { elements: { role: 'c10000' } }, false],
    ['a context key c0', { elements: { role: 'c0' } }, false],
    ['a context key c01', { elements: { role: 'c01' } }, false],
  ])('%s', (_name, parts, accepted) => {
    agree(routeWith(parts), accepted);
  });

  it.each([
    ['five candidates', ['c1', 'c2', 'c3', 'c4', 'c5'], true],
    ['six candidates', ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'], false],
  ])('clarify with %s', (_name, candidates, accepted) => {
    agree({ route: 'clarify', intent: 'x', role: 'r', entities: {}, candidates }, accepted);
  });

  it.each([
    ['eight type names of 80 characters', { route: 'meaning', types: Array.from({ length: 8 }, () => 'n'.repeat(80)) }, true],
    ['a type name of 81 characters', { route: 'meaning', types: ['n'.repeat(81)] }, false],
    ['nine type names', { route: 'meaning', types: Array.from({ length: 9 }, () => 'n') }, false],
  ])('meaning with %s', (_name, reply, accepted) => {
    agree(reply, accepted);
  });
});

describe('the schema of the classifier reply', () => {
  const intents = ['first-intent', 'second-intent'];
  const valid = validates(classificationSchema(intents));

  it.each([
    ['an intent and its entity', { intent: 'first-intent', entities: { subject: 'S-1' } }],
    ['the saved-pattern intent', { intent: ASK_SAVED_PATTERN_INTENT, entities: { pattern: 'k1' } }],
    ['null and no entity', { intent: null, entities: {} }],
  ])('accepts a reply the strict reader accepts: %s', (_name, reply) => {
    expect(readClassification(JSON.stringify(reply), [...intents, ASK_SAVED_PATTERN_INTENT]).ok).toBe(true);
    expect(valid(reply), JSON.stringify(valid.errors)).toBe(true);
  });

  it('is stricter in one place only: an intent outside the folders cannot be produced, where the reader would say unknown-intent', () => {
    const reply = { intent: 'a-third-intent', entities: {} };
    expect(readClassification(JSON.stringify(reply), intents)).toEqual({ ok: false, cause: 'unknown-intent' });
    expect(valid(reply)).toBe(false);
  });

  it('is looser than the reader for null with entities, which the reader refuses', () => {
    const reply = { intent: null, entities: { a: 'v' } };
    expect(readClassification(JSON.stringify(reply), intents).ok).toBe(false);
    expect(valid(reply)).toBe(true);
  });

  it('refuses a reply with another key or text around it', () => {
    expect(valid({ intent: 'first-intent', entities: {}, extra: 1 })).toBe(false);
    expect(valid('first-intent')).toBe(false);
  });
});

describe('the schema of the summary draft', () => {
  const valid = validates(summarySchema());

  it.each([
    ['sentences with citations', { sentences: [{ text: 'A sentence.', cites: ['c1', 'c2'] }] }],
    ['no sentence', { sentences: [] }],
    ['with the names of types that have no description', { sentences: [], noDescription: ['Thing'] }],
  ])('accepts %s', (_name, reply) => {
    expect(valid(reply), JSON.stringify(valid.errors)).toBe(true);
  });

  it.each([
    ['a sentence without cites', { sentences: [{ text: 'A sentence.' }] }],
    ['an empty text', { sentences: [{ text: '', cites: [] }] }],
    ['an extra key', { sentences: [], more: 1 }],
    ['thirteen sentences', { sentences: Array.from({ length: 13 }, () => ({ text: 'S.', cites: [] })) }],
  ])('refuses %s', (_name, reply) => {
    expect(valid(reply)).toBe(false);
  });
});

describe('the schemas of a run by kind', () => {
  it('names the prompt each kind of run constrains, and nothing else', () => {
    expect(Object.keys(schemasOf('ask', ['i']))).toEqual(['ask.classify']);
    expect(Object.keys(schemasOf('assistant', []))).toEqual(['assistant.route']);
    expect(Object.keys(schemasOf('summary', []))).toEqual(['case-summary']);
  });

  it('compiles under strict mode of the validator', () => {
    for (const schema of [routerSchema(), classificationSchema(['a']), summarySchema()]) expect(() => new Ajv({ strict: true }).compile(schema)).not.toThrow();
  });
});
