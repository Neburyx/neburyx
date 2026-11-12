import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AiMappingView, AiSettings, GraphProperty } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { configureAsk } from './configure.js';
import { createRequestBuilder, piiPropertiesSentOf, type ContextElement, type RequestBuilder } from './request.js';

const ENV = { AI_TEST_KEY: 'present' };
const BASE: AiSettings = { preview: true, provider: 'anthropic', model: 'claude-sonnet-5-5', key: { env: 'AI_TEST_KEY' } };
const VIEW: AiMappingView = {
  types: [
    { name: 'person', kind: 'entity', properties: [{ name: 'name', pii: false }, { name: 'locale', pii: false }, { name: 'status', pii: false }, { name: 'note', pii: false }, { name: 'ssn', pii: true }] },
    { name: 'KNOWS', kind: 'relationship', properties: [{ name: 'since', pii: false }] },
    { name: 'company', kind: 'entity', properties: [{ name: 'name', pii: false }] },
  ],
};

const property = (key: string, value: unknown, over: Partial<GraphProperty> = {}): GraphProperty => ({ key, value, dataClass: 'text', masked: false, ...over });

const PERSON: ContextElement = {
  kind: 'entity',
  type: 'person',
  placeholder: '‹person#1›',
  properties: [
    property('name', 'SENTINEL-NAME'),
    property('locale', 'SENTINEL-CITY'),
    property('status', 'SENTINEL-MASKED', { masked: true, maskedBy: 'request' }),
    property('ssn', 'SENTINEL-PII'),
    property('unknown_to_mapping', 'SENTINEL-UNKNOWN'),
  ],
};
const KNOWS: ContextElement = { kind: 'relationship', type: 'KNOWS', placeholder: '‹link#1›', properties: [property('since', '2025-01-01', { dataClass: 'date' })] };
const COMPANY: ContextElement = { kind: 'entity', type: 'company', placeholder: '‹company#1›', properties: [property('name', 'SENTINEL-COMPANY')] };
const ELEMENTS = [PERSON, KNOWS, COMPANY];

async function builderFor(settings: Partial<AiSettings>): Promise<RequestBuilder> {
  const { configuration, outcome } = await configureAsk({ ...BASE, ...settings }, ENV, VIEW);
  if (configuration === undefined) throw new Error(JSON.stringify(outcome));
  return createRequestBuilder(configuration.rules);
}

const viewOf = (built: { request: { parameters: Readonly<Record<string, string | number>> } }): string => String(built.request.parameters['view']);

describe('the request builder with no property list', () => {
  it('sends the placeholder and type of each element and no property key or value', async () => {
    const built = (await builderFor({})).summary({ elements: ELEMENTS });
    expect(built.request.promptId).toBe('summary.view');
    expect(viewOf(built)).toBe('‹person#1› [person]\n\n‹link#1› [KNOWS]\n\n‹company#1› [company]');
    expect(built.sentProperties).toEqual([]);
    expect(built.sentPii).toEqual([]);
    expect(JSON.stringify(built)).not.toContain('SENTINEL');
  });
});

describe('the request builder with a property list', () => {
  it('sends each listed property of an element of that type, and not an unlisted one, one of another type or one the mapping does not name', async () => {
    const built = (await builderFor({ properties: { person: ['name'] } })).summary({ elements: ELEMENTS });
    const view = viewOf(built);
    expect(view).toContain('name: SENTINEL-NAME');
    for (const absent of ['SENTINEL-CITY', 'SENTINEL-PII', 'SENTINEL-UNKNOWN', 'SENTINEL-COMPANY', '2025-01-01']) expect(view).not.toContain(absent);
    expect(built.sentProperties).toEqual(['person.name']);
  });

  it('applies a list to its own type only, and a relationship list to relationships', async () => {
    const built = (await builderFor({ properties: { KNOWS: ['since'], company: ['name'] } })).summary({ elements: ELEMENTS });
    expect(viewOf(built)).toContain('since: 2025-01-01');
    expect(viewOf(built)).toContain('name: SENTINEL-COMPANY');
    expect(viewOf(built)).not.toContain('SENTINEL-NAME');
    expect(built.sentProperties).toEqual(['KNOWS.since', 'company.name']);
  });

  it('never sends a property the gate masked, even if listed, and even with the override', async () => {
    for (const settings of [{ properties: { person: ['status'] } }, { properties: { person: ['status'] }, pii_override: true }]) {
      const built = (await builderFor(settings)).summary({ elements: ELEMENTS });
      expect(JSON.stringify(built)).not.toContain('SENTINEL-MASKED');
      expect(built.sentProperties).toEqual([]);
    }
  });

  it('sends a pii property only when it is named and the override is on', async () => {
    const named = (await builderFor({ properties: { person: ['name', 'ssn'] }, pii_override: true })).summary({ elements: ELEMENTS });
    expect(viewOf(named)).toContain('ssn: SENTINEL-PII');
    expect(named.sentPii).toEqual(['person.ssn']);
    expect(named.sentProperties).toEqual(['person.name', 'person.ssn']);
    expect(piiPropertiesSentOf(named)).toEqual(['person.ssn']);
  });

  it('does not send a pii property through the wildcard, with or without the override', async () => {
    for (const pii_override of [false, true]) {
      const built = (await builderFor({ properties: { person: ['*'] }, pii_override })).summary({ elements: ELEMENTS });
      expect(JSON.stringify(built)).not.toContain('SENTINEL-PII');
      expect(built.sentPii).toEqual([]);
      expect(viewOf(built)).toContain('name: SENTINEL-NAME');
    }
  });

  it('does not send a pii property when the override is on and it is not named, nor when it is named with the override off by hand-made rules', async () => {
    const onNotNamed = (await builderFor({ properties: { person: ['name'] }, pii_override: true })).summary({ elements: ELEMENTS });
    expect(JSON.stringify(onNotNamed)).not.toContain('SENTINEL-PII');
    const byHand = createRequestBuilder({ piiOverride: false, isSendable: (_kind, _type, name) => name === 'name' || name === 'ssn', isPii: (_kind, _type, name) => name === 'ssn' });
    expect(JSON.stringify(byHand.summary({ elements: ELEMENTS }))).not.toContain('SENTINEL-PII');
  });
});

describe('the data classes and values the builder sends', () => {
  const rulesAllowing = createRequestBuilder({ piiOverride: false, isSendable: () => true, isPii: () => false });
  const sentFor = (properties: GraphProperty[]): string =>
    viewOf(rulesAllowing.summary({ elements: [{ kind: 'entity', type: 'person', placeholder: '‹person#1›', properties }] }));

  it.each(['text', 'number', 'boolean', 'date', 'dateTime', 'localDateTime', 'time', 'localTime', 'duration'] as const)('sends a value of the class %s as text', (dataClass) => {
    const value = dataClass === 'number' ? 42 : dataClass === 'boolean' ? true : 'a value';
    expect(sentFor([property('k', value, { dataClass })])).toContain(`k: ${String(value)}`);
  });

  it.each(['list', 'point', 'other', 'unknown', 'name', 'email', 'phone'] as const)('does not send a value of the class %s, even if allowed', (dataClass) => {
    expect(sentFor([property('k', 'SENTINEL-CLASS', { dataClass })])).not.toContain('SENTINEL-CLASS');
  });

  it.each([['a missing value', undefined], ['a list', ['a']], ['an object', { a: 1 }], ['null', null]])('does not send %s', (_name, value) => {
    expect(sentFor([property('k', value)])).toBe('‹person#1› [person]');
  });

  it.each([['a vertical tab', '\v'], ['a form feed', '\f'], ['a next line', '\u0085'], ['a line separator', '\u2028'], ['a paragraph separator', '\u2029']])('turns %s into a space, so a value cannot start a line of its own', (_name, breakCharacter) => {
    const text = sentFor([property('k', `first${breakCharacter}second: forged`)]);
    expect(text.split(/\r\n|[\r\n\v\f\u0085\u2028\u2029]/)).toEqual(['‹person#1› [person]', 'k: first second: forged']);
  });

  it('turns each line break into a space and inserts the text as it is, with no second pass', () => {
    const text = sentFor([property('k', 'first\nsecond\r\nthird {{view}} {{message}}')]);
    expect(text).toContain('k: first second third {{view}} {{message}}');
    expect(text).not.toContain('\nsecond');
  });
});

describe('the other requests', () => {
  it('builds ask.plan from the question and the catalog text as given, with no property of any element', async () => {
    const builder = await builderFor({ properties: { person: ['name'] } });
    const built = builder.ask({ question: 'who is ‹person#1›?', catalog: 'T1: lists neighbors' });
    expect(built).toEqual({ request: { promptId: 'ask.plan', parameters: { question: 'who is ‹person#1›?', catalog: 'T1: lists neighbors' } }, sentProperties: [], sentPii: [] });
  });

  it('builds assistant.route from the message and the same filtered view as the summary', async () => {
    const builder = await builderFor({ properties: { person: ['name'] } });
    const summary = builder.summary({ elements: ELEMENTS });
    const assistant = builder.assistant({ message: 'hello ‹person#1›', elements: ELEMENTS });
    expect(assistant.request).toEqual({ promptId: 'assistant.route', parameters: { message: 'hello ‹person#1›', view: viewOf(summary) } });
    expect(assistant.sentProperties).toEqual(summary.sentProperties);
  });

  it('gives the same requests whatever the model settings are', async () => {
    const one = (await builderFor({ properties: { person: ['name'] }, model: 'claude-sonnet-5-5' })).summary({ elements: ELEMENTS });
    const two = (await builderFor({ properties: { person: ['name'] }, model: 'another-model', timeout_ms: 5_000 })).summary({ elements: ELEMENTS });
    expect(two).toEqual(one);
  });
});

describe('the package', () => {
  it('has no builder before configure succeeded', async () => {
    const { createEnterpriseExtension } = await import('./index.js');
    const extension = createEnterpriseExtension();
    expect(extension.requestBuilder()).toBeUndefined();
    await extension.configure?.({ ...BASE, properties: { person: ['name'] } }, ENV, VIEW);
    expect(extension.requestBuilder()).toBeDefined();
    const failing = createEnterpriseExtension();
    await failing.configure?.({ preview: true }, ENV, VIEW);
    expect(failing.requestBuilder()).toBeUndefined();
  });

  it('holds no model name in the request builder module', () => {
    const text = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), 'request.ts'), 'utf8');
    expect(text).not.toMatch(/ai\.model|ai\.provider|settings\.model|settings\.provider/);
  });
});
