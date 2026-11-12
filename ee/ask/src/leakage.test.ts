import type { AiMappingView, AiSettings, AuditEvent, AuditSink, GraphProperty } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { createAuditedModelCall } from './audited.js';
import { configureAsk } from './configure.js';
import { buildPromptRegistry } from './prompts.js';
import { createRequestBuilder, piiPropertiesSentOf, type BuiltRequest, type ContextElement } from './request.js';
import { createFixtureProvider, replyKey } from './testing/fixture.js';

const ENV = { AI_TEST_KEY: 'present' };
const BASE: AiSettings = { preview: true, provider: 'anthropic', model: 'claude-sonnet-5-5', key: { env: 'AI_TEST_KEY' } };
const VIEW: AiMappingView = {
  types: [{ name: 'person', kind: 'entity', properties: [{ name: 'name', pii: false }, { name: 'locale', pii: false }, { name: 'hobby', pii: false }, { name: 'status', pii: false }, { name: 'note', pii: false }, { name: 'ssn', pii: true }] }],
};

const SENTINELS = { ordinary: 'SENTINEL-ORDINARY', listed: 'SENTINEL-LISTED', unlisted: 'SENTINEL-UNLISTED', pii: 'SENTINEL-PII', masked: 'SENTINEL-MASKED', maskedText: '‹masked›' } as const;
const property = (key: string, value: string, over: Partial<GraphProperty> = {}): GraphProperty => ({ key, value, dataClass: 'text', masked: false, ...over });

const PERSON: ContextElement = {
  kind: 'entity',
  type: 'person',
  placeholder: '‹person#1›',
  properties: [
    property('name', SENTINELS.ordinary),
    property('locale', SENTINELS.listed),
    property('hobby', SENTINELS.unlisted),
    property('ssn', SENTINELS.pii),
    property('status', SENTINELS.masked, { masked: true, maskedBy: 'request' }),
    property('note', SENTINELS.maskedText, { masked: true, maskedBy: 'request' }),
  ],
};

const SIGNAL = new AbortController().signal;

async function received(settings: Partial<AiSettings>, build: (builder: ReturnType<typeof createRequestBuilder>) => BuiltRequest): Promise<{ readonly text: string; readonly built: BuiltRequest }> {
  const { configuration, outcome } = await configureAsk({ ...BASE, ...settings }, ENV, VIEW);
  if (configuration === undefined) throw new Error(JSON.stringify(outcome));
  const registry = await buildPromptRegistry();
  if (!registry.ok) throw new Error(registry.problems.join('; '));
  const replies = { [replyKey('ask.plan', 1)]: { kind: 'refused' as const }, [replyKey('summary.view', 1)]: { kind: 'refused' as const }, [replyKey('assistant.route', 1)]: { kind: 'refused' as const } };
  const provider = createFixtureProvider({ registry: registry.registry, replies });
  const built = build(createRequestBuilder(configuration.rules));
  await provider.complete(built.request, SIGNAL);
  expect(provider.calls).toHaveLength(1);
  return { text: JSON.stringify(provider.calls[0]), built };
}

const summary = (builder: ReturnType<typeof createRequestBuilder>): BuiltRequest => builder.summary({ elements: [PERSON] });
const seen = (text: string, key: keyof typeof SENTINELS): boolean => text.includes(SENTINELS[key]);

describe('what a provider receives', () => {
  it('holds none of the sentinels when there is no property list', async () => {
    const { text } = await received({}, summary);
    for (const key of Object.keys(SENTINELS) as (keyof typeof SENTINELS)[]) expect(seen(text, key), key).toBe(false);
    expect(text).toContain('‹person#1› [person]');
  });

  it('holds the listed values and none of the others', async () => {
    const { text } = await received({ properties: { person: ['name', 'locale'] } }, summary);
    expect([seen(text, 'ordinary'), seen(text, 'listed')]).toEqual([true, true]);
    for (const key of ['unlisted', 'pii', 'masked'] as const) expect(seen(text, key), key).toBe(false);
  });

  it('holds no pii value when a pii property is named without the override: the settings are refused, and rules made by hand still send none', async () => {
    const refused = await configureAsk({ ...BASE, properties: { person: ['ssn'] } }, ENV, VIEW);
    expect(refused.outcome).toMatchObject({ ok: false });
    expect(refused.configuration).toBeUndefined();
    const byHand = createRequestBuilder({ piiOverride: false, isSendable: (_kind, _type, name) => name === 'ssn', isPii: (_kind, _type, name) => name === 'ssn' });
    const built = byHand.summary({ elements: [PERSON] });
    expect(JSON.stringify(built.request).includes(SENTINELS.pii)).toBe(false);
    expect(built.sentPii).toEqual([]);
  });

  it('holds the pii value only with the override and the name, and reports it by type.property', async () => {
    const { text, built } = await received({ properties: { person: ['name', 'ssn'] }, pii_override: true }, summary);
    expect(seen(text, 'pii')).toBe(true);
    expect(built.sentPii).toEqual(['person.ssn']);
    expect(built.sentProperties).toEqual(['person.name', 'person.ssn']);
    expect(JSON.stringify(built.sentPii)).not.toContain(SENTINELS.pii);
  });

  it('holds neither the masked text nor the value of a masked property, with and without the override', async () => {
    for (const settings of [{ properties: { person: ['status', 'note'] } }, { properties: { person: ['status', 'note'] }, pii_override: true }]) {
      const { text } = await received(settings, summary);
      expect(seen(text, 'maskedText')).toBe(false);
      expect(seen(text, 'masked')).toBe(false);
    }
  });

  it('holds a property in the summary and the assistant requests, and never in the ask request', async () => {
    const settings = { properties: { person: ['name'] } };
    expect(seen((await received(settings, summary)).text, 'ordinary')).toBe(true);
    expect(seen((await received(settings, (builder) => builder.assistant({ message: 'hi ‹person#1›', elements: [PERSON] }))).text, 'ordinary')).toBe(true);
    const ask = await received(settings, (builder) => builder.ask({ question: 'who is ‹person#1›?', catalog: 'T1' }));
    for (const key of Object.keys(SENTINELS) as (keyof typeof SENTINELS)[]) expect(seen(ask.text, key), key).toBe(false);
  });
});

describe('what the audit holds of a call that sent a pii property', () => {
  async function auditedCall(settings: Partial<AiSettings>) {
    const { configuration, outcome } = await configureAsk({ ...BASE, ...settings }, ENV, VIEW);
    if (configuration === undefined) throw new Error(JSON.stringify(outcome));
    const events: AuditEvent[] = [];
    const sink: AuditSink = { record: async (event) => void events.push(event) };
    const fixture = createFixtureProvider({ registry: configuration.registry, replies: { [replyKey('summary.view', 1)]: { kind: 'ok', text: 'a draft' } } });
    const audited = createAuditedModelCall({ provider: fixture, configuration, sink });
    const built = createRequestBuilder(configuration.rules).summary({ elements: [PERSON] });
    await audited.call(built.request, { actorId: '01939999-0000-7000-8000-0000000000aa', actorRole: 'investigator', traceId: 'tr-1', piiPropertiesSent: piiPropertiesSentOf(built) }, SIGNAL);
    return { events, received: JSON.stringify(fixture.calls) };
  }

  it('names the pii property as type.property in the event, and holds no value of it, when the override sent one', async () => {
    const { events, received } = await auditedCall({ properties: { person: ['name', 'ssn'] }, pii_override: true });
    expect(received).toContain(SENTINELS.pii);
    expect(events).toHaveLength(1);
    expect(events[0]?.detail).toMatchObject({ ai: { piiPropertiesSent: ['person.ssn'] } });
    expect(JSON.stringify(events)).not.toContain(SENTINELS.pii);
    expect(JSON.stringify(events)).not.toContain(SENTINELS.ordinary);
  });

  it('holds no piiPropertiesSent when no pii property was sent', async () => {
    const { events } = await auditedCall({ properties: { person: ['name'] } });
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0]?.detail)).not.toContain('piiPropertiesSent');
  });
});
