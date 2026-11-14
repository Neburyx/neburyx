import { describe, expect, it } from 'vitest';
import { ASK_REFUSAL_CAUSES } from './ask.js';
import { ASK_REFUSAL_SENTENCES, readClassification } from './ask-classify.js';

const NAMES = ['byId', 'shared'];
const read = (text: string) => readClassification(text, NAMES);

describe('a reply of the classifier', () => {
  it('is read when it is exactly one object of the form, with whitespace around it allowed', () => {
    expect(read('{"intent":"byId","entities":{"id":"A-1","name":"Zoë 007"}}')).toEqual({ ok: true, intent: 'byId', entities: { id: 'A-1', name: 'Zoë 007' } });
    expect(read('\n  {"entities":{},"intent":"shared"}  \n')).toEqual({ ok: true, intent: 'shared', entities: {} });
  });

  it('reads no intent as null with no entities', () => {
    expect(read('{"intent":null,"entities":{}}')).toEqual({ ok: true, intent: null, entities: {} });
  });

  it('is an unknown intent when the name is not one the source has, and nothing is repeated', () => {
    expect(read('{"intent":"SENTINEL_NAME","entities":{}}')).toEqual({ ok: false, cause: 'unknown-intent' });
    expect(readClassification('{"intent":"saved-pattern","entities":{}}', NAMES)).toEqual({ ok: false, cause: 'unknown-intent' });
    expect(readClassification('{"intent":"saved-pattern","entities":{}}', [...NAMES, 'saved-pattern'])).toMatchObject({ ok: true });
  });

  it.each([
    ['text before the object', 'Here it is: {"intent":"byId","entities":{}}'],
    ['text after the object', '{"intent":"byId","entities":{}} Thanks'],
    ['a code fence', '```json\n{"intent":"byId","entities":{}}\n```'],
    ['two objects', '{"intent":"byId","entities":{}}{"intent":"byId","entities":{}}'],
    ['an array', '[{"intent":"byId","entities":{}}]'],
    ['no object', 'I cannot say'],
    ['an empty reply', ''],
    ['an extra key', '{"intent":"byId","entities":{},"why":"x"}'],
    ['a missing intent', '{"entities":{}}'],
    ['a missing entities', '{"intent":"byId"}'],
    ['a duplicate top-level key', '{"intent":"byId","intent":"shared","entities":{}}'],
    ['a duplicate entity key', '{"intent":"byId","entities":{"id":"a","id":"b"}}'],
    ['an intent that is a number', '{"intent":1,"entities":{}}'],
    ['entities that are an array', '{"intent":"byId","entities":[]}'],
    ['entities that are null', '{"intent":"byId","entities":null}'],
    ['an entity that is a number', '{"intent":"byId","entities":{"id":5}}'],
    ['an entity that is a boolean', '{"intent":"byId","entities":{"id":true}}'],
    ['an entity that is empty text', '{"intent":"byId","entities":{"id":""}}'],
    ['an entity that is null', '{"intent":"byId","entities":{"id":null}}'],
    ['an entity that is an object', '{"intent":"byId","entities":{"id":{"a":1}}}'],
    ['an entity that is a list', '{"intent":"byId","entities":{"id":["a"]}}'],
    ['an entity key with a dash', '{"intent":"byId","entities":{"a-b":"x"}}'],
    ['an entity key that starts with a digit', '{"intent":"byId","entities":{"1a":"x"}}'],
    ['a string with a control character', '{"intent":"byId","entities":{"id":"a\\u0000b"}}'],
    ['a string with a newline', '{"intent":"byId","entities":{"id":"a\\nb"}}'],
    ['a string with a lone surrogate', '{"intent":"byId","entities":{"id":"\\ud800"}}'],
    ['a string over 256 code points', `{"intent":"byId","entities":{"id":"${'x'.repeat(257)}"}}`],
    ['no intent with entities', '{"intent":null,"entities":{"id":"a"}}'],
    ['an entity named __proto__', '{"intent":null,"entities":{"__proto__":"x"}}'],
    ['an entity named __proto__ with an intent', '{"intent":"byId","entities":{"__proto__":"x","id":"a"}}'],
  ])('is a reply that does not fit: %s', (_name, text) => {
    expect(read(text)).toEqual({ ok: false, cause: 'bad-reply' });
  });

  it('takes 20 entities and refuses 21, and takes a string of 256 code points of any width', () => {
    const entities = (count: number): string => JSON.stringify(Object.fromEntries(Array.from({ length: count }, (_, index) => [`p${index}`, `v${index}`])));
    expect(read(`{"intent":"byId","entities":${entities(20)}}`)).toMatchObject({ ok: true });
    expect(read(`{"intent":"byId","entities":${entities(21)}}`)).toEqual({ ok: false, cause: 'bad-reply' });
    expect(read(`{"intent":"byId","entities":{"id":"${'😀'.repeat(256)}"}}`)).toMatchObject({ ok: true });
    expect(read(`{"intent":"byId","entities":{"id":"${'😀'.repeat(257)}"}}`)).toEqual({ ok: false, cause: 'bad-reply' });
  });

  it('is refused in bounded time when it is huge or deeply nested or not text', () => {
    const started = Date.now();
    expect(read(`{"intent":"byId","entities":{},"x":"${'a'.repeat(200_000)}"}`)).toEqual({ ok: false, cause: 'bad-reply' });
    expect(read(`{"intent":"byId","entities":{},"x":"${'a'.repeat(99_950)}"}`)).toEqual({ ok: false, cause: 'bad-reply' });
    expect(read(`${'['.repeat(5000)}${']'.repeat(5000)}`)).toEqual({ ok: false, cause: 'bad-reply' });
    expect(read(`{"intent":"byId","entities":${'{"a":'.repeat(5000)}1${'}'.repeat(5000)}}`)).toEqual({ ok: false, cause: 'bad-reply' });
    expect(read('\u0000￾{')).toEqual({ ok: false, cause: 'bad-reply' });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('never repeats any text of the reply in its answer', () => {
    expect(JSON.stringify(read('{"intent":"SENTINEL","entities":{"SENTINEL":"SENTINEL"},"SENTINEL":1}'))).not.toContain('SENTINEL');
  });
});

describe('the fixed sentences of the causes', () => {
  it('give every cause one sentence of at most 300 characters', () => {
    expect(Object.keys(ASK_REFUSAL_SENTENCES).sort()).toEqual([...ASK_REFUSAL_CAUSES].sort());
    for (const sentence of Object.values(ASK_REFUSAL_SENTENCES)) {
      expect(sentence.length).toBeGreaterThan(5);
      expect(sentence.length).toBeLessThanOrEqual(300);
      expect(sentence).not.toMatch(/[{}"`$]/);
    }
  });
});
