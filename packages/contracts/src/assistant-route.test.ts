import { describe, expect, it } from 'vitest';
import { readAssistantRoute } from './assistant-route.js';

describe('the reading of a reply of the router', () => {
  it('reads each of the three forms', () => {
    expect(readAssistantRoute('{"route":"view"}')).toEqual({ ok: true, reply: { route: 'view' } });
    expect(readAssistantRoute(' {"route":"refuse","cause":"verdict"} ')).toEqual({ ok: true, reply: { route: 'refuse', cause: 'verdict' } });
    expect(readAssistantRoute('{"route":"ask","intent":"byId","entities":{"id":"A-1"}}')).toEqual({ ok: true, reply: { route: 'ask', intent: 'byId', entities: { id: 'A-1' } } });
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
  ])('does not read %j', (text) => {
    expect(readAssistantRoute(text)).toEqual({ ok: false });
  });

  it('does not read a reply over the size limit', () => {
    expect(readAssistantRoute(`{"route":"ask","intent":"byId","entities":{"id":"${'a'.repeat(100_001)}"}}`)).toEqual({ ok: false });
  });
});
