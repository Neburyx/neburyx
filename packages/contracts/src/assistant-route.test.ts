import { describe, expect, it } from 'vitest';
import { readAssistantRoute } from './assistant-route.js';

describe('the reading of a reply of the router', () => {
  it('reads each of the three forms', () => {
    expect(readAssistantRoute('{"route":"view"}')).toEqual({ ok: true, reply: { route: 'view' } });
    expect(readAssistantRoute(' {"route":"refuse","cause":"verdict"} ')).toEqual({ ok: true, reply: { route: 'refuse', cause: 'verdict' } });
    expect(readAssistantRoute('{"route":"ask","intent":"byId","entities":{"id":"A-1"}}')).toEqual({ ok: true, reply: { route: 'ask', intent: 'byId', entities: { id: 'A-1' } } });
  });

  it('reads an ask that names an element of the context by its key in a member of its own, beside typed values', () => {
    expect(readAssistantRoute('{"route":"ask","intent":"byId","entities":{},"elements":{"id":"c1"}}')).toEqual({ ok: true, reply: { route: 'ask', intent: 'byId', entities: {}, elements: { id: 'c1' } } });
    expect(readAssistantRoute('{"route":"ask","intent":"pair","entities":{"b":"A-9"},"elements":{"a":"c12"}}')).toEqual({ ok: true, reply: { route: 'ask', intent: 'pair', entities: { b: 'A-9' }, elements: { a: 'c12' } } });
  });

  it('reads a clarify: the intent, the one role awaiting the choice, the values of the other roles and the keys it may mean', () => {
    expect(readAssistantRoute('{"route":"clarify","intent":"byId","role":"id","entities":{},"candidates":["c1","c2"]}')).toEqual({ ok: true, reply: { route: 'clarify', intent: 'byId', role: 'id', entities: {}, candidates: ['c1', 'c2'] } });
    expect(readAssistantRoute('{"route":"clarify","intent":"pair","role":"b","entities":{"a":"A-1"},"elements":{"c":"c3"},"candidates":["c1","c2","c4","c5","c6"]}')).toEqual({ ok: true, reply: { route: 'clarify', intent: 'pair', role: 'b', entities: { a: 'A-1' }, elements: { c: 'c3' }, candidates: ['c1', 'c2', 'c4', 'c5', 'c6'] } });
  });

  it.each([
    '{"route":"clarify","intent":"byId","role":"id","entities":{},"candidates":["c1"]}',
    '{"route":"clarify","intent":"byId","role":"id","entities":{},"candidates":["c1","c2","c3","c4","c5","c6"]}',
    '{"route":"clarify","intent":"byId","role":"id","entities":{},"candidates":["c1","c1"]}',
    '{"route":"clarify","intent":"byId","role":"id","entities":{},"candidates":["c1","A-2"]}',
    '{"route":"clarify","intent":"byId","role":"id","entities":{},"candidates":["c1",2]}',
    '{"route":"clarify","intent":"byId","role":"id","entities":{},"candidates":"c1"}',
    '{"route":"clarify","intent":"byId","entities":{},"candidates":["c1","c2"]}',
    '{"route":"clarify","intent":"byId","role":"id","entities":{"id":"A-1"},"candidates":["c1","c2"]}',
    '{"route":"clarify","intent":"byId","role":"id","entities":{},"elements":{"id":"c3"},"candidates":["c1","c2"]}',
    '{"route":"clarify","intent":"byId","role":"id","entities":{},"candidates":["c1","c2"],"extra":1}',
    '{"route":"clarify","intent":"byId","role":"1; DROP","entities":{},"candidates":["c1","c2"]}',
    '{"route":"clarify","intent":"by Id","role":"id","entities":{},"candidates":["c1","c2"]}',
  ])('does not read the clarify %j', (text) => {
    expect(readAssistantRoute(text)).toEqual({ ok: false });
  });

  it.each([
    '',
    'view',
    '[]',
    '{"route":"view","extra":1}',
    '{"route":"refuse"}',
    '{"route":"refuse","cause":"other"}',
    '{"route":"ask","intent":"1; DROP","entities":{}}',
    '{"route":"ask","intent":"byId"}',
    '{"route":"ask","intent":"byId","entities":{"id":""}}',
    '{"route":"ask","intent":"byId","entities":{"id":"a"},"cause":"verdict"}',
    '{"route":"view","route":"view"}',
    '{"sentences":[]}',
    '{"route":"ask","intent":"byId","entities":{"id":"A-1"},"elements":{"id":"c1"}}',
    '{"route":"ask","intent":"byId","entities":{},"elements":{"id":1}}',
    '{"route":"ask","intent":"byId","entities":{},"elements":{"id":null}}',
    '{"route":"ask","intent":"byId","entities":{},"elements":{"id":"A-1"}}',
    '{"route":"ask","intent":"byId","entities":{},"elements":{"id":"c0"}}',
    '{"route":"ask","intent":"byId","entities":{},"elements":{"id":"c1 "}}',
    '{"route":"ask","intent":"byId","entities":{},"elements":{"id":"[\\"node\\",\\"s\\",\\"widget\\",\\"A-1\\"]"}}',
    '{"route":"ask","intent":"byId","entities":{},"elements":[]}',
    '{"route":"ask","intent":"byId","entities":{},"elements":{"__proto__":"c1"}}',
    '{"route":"ask","intent":"byId","entities":{},"elements":{"id":"c1","id":"c2"}}',
    '{"route":"view","elements":{}}',
  ])('does not read %j', (text) => {
    expect(readAssistantRoute(text)).toEqual({ ok: false });
  });

  it('does not read a reply over the size limit', () => {
    expect(readAssistantRoute(`{"route":"ask","intent":"byId","entities":{"id":"${'a'.repeat(100_001)}"}}`)).toEqual({ ok: false });
  });
});

describe('the meaning route', () => {
  it('reads the names the analyst wrote, one to eight, as text', () => {
    expect(readAssistantRoute('{"route":"meaning","types":["account","LIVES_AT"]}')).toEqual({ ok: true, reply: { route: 'meaning', types: ['account', 'LIVES_AT'] } });
  });

  it.each([
    ['no names', '{"route":"meaning","types":[]}'],
    ['nine names', JSON.stringify({ route: 'meaning', types: Array.from({ length: 9 }, (_, i) => `t${i}`) })],
    ['a blank name', '{"route":"meaning","types":["  "]}'],
    ['a name over 80 characters', JSON.stringify({ route: 'meaning', types: ['x'.repeat(81)] })],
    ['a control character', '{"route":"meaning","types":["a\\nb"]}'],
    ['a non-text name', '{"route":"meaning","types":[5]}'],
    ['another member', '{"route":"meaning","types":["a"],"intent":"x"}'],
    ['no types member', '{"route":"meaning"}'],
  ])('refuses %s', (_name, text) => {
    expect(readAssistantRoute(text)).toEqual({ ok: false });
  });
});

