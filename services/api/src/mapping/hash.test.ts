import { stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import { baseSource, fileOf, firstSource, load, type Json } from '../testing/mapping.js';
import { canonicalText } from './hash.js';
import { parseMapping } from './load.js';

function hashOf(source: Json): string {
  return firstSource(load(source)).configHash;
}

const fullEntity: Json = {
  type: 'node_a',
  label: 'NodeA',
  stable_id: 'id',
  search: ['name'],
  link: 'https://records.example.test/items/{id}',
  display: { icon: 'document', key_properties: ['name'], state_property: 'status' },
};
const fullRelationship: Json = {
  type: 'LINKS',
  from: 'node_a',
  to: 'node_b',
  evidence: ['recordId'],
  evidence_link: 'https://audit.example.test/records/{recordId}',
};

function fullSource(overrides: Json = {}): Json {
  return baseSource({
    entities: [fullEntity, { type: 'node_b', label: 'NodeB', stable_id: 'key' }],
    relationships: [fullRelationship],
    derived: [{ id: 'shared', from: 'node_a', to: 'node_a', via: ['LINKS', 'node_b', 'LINKS'], rule_version: 1 }],
    patterns: [{ id: 'p', name: 'P', template: 'shared-attribute', bind: { anchor: 'node_a', attribute: 'node_b', via: 'LINKS' } }],
    vocabulary: { case_ref: 'Referral' },
    style_rules: [{ id: 'r' }],
    ...overrides,
  });
}

function withEntity(overrides: Json): Json {
  const entities = [{ ...fullEntity, ...overrides }, { type: 'node_b', label: 'NodeB', stable_id: 'key' }];
  return fullSource({ entities });
}

function withDisplay(overrides: Json): Json {
  return withEntity({ display: { icon: 'document', key_properties: ['name'], state_property: 'status', ...overrides } });
}

function withRelationship(overrides: Json): Json {
  return fullSource({ relationships: [{ ...fullRelationship, ...overrides }] });
}

describe('the mapping hash', () => {
  it('is equal for the same source with different key order, comments, whitespace and quoting', () => {
    const plain = hashOf(fullSource());
    const reordered = stringify({
      sources: [
        {
          style_rules: [{ id: 'r' }],
          vocabulary: { case_ref: 'Referral' },
          patterns: [{ bind: { via: 'LINKS', attribute: 'node_b', anchor: 'node_a' }, template: 'shared-attribute', name: 'P', id: 'p' }],
          derived: [{ rule_version: 1, via: ['LINKS', 'node_b', 'LINKS'], to: 'node_a', from: 'node_a', id: 'shared' }],
          relationships: [{ evidence_link: 'https://audit.example.test/records/{recordId}', evidence: ['recordId'], to: 'node_b', from: 'node_a', type: 'LINKS' }],
          entities: [
            { display: { state_property: 'status', key_properties: ['name'], icon: 'document' }, link: 'https://records.example.test/items/{id}', search: ['name'], stable_id: 'id', label: 'NodeA', type: 'node_a' },
            { stable_id: 'key', label: 'NodeB', type: 'node_b' },
          ],
          auth: { password_env: 'DEMO_PASSWORD', username_env: 'DEMO_USER', kind: 'basic' },
          database: 'neo4j',
          uri: 'neo4j+s://graph.example.test:7687',
          id: 'demo',
        },
      ],
    });
    const quoted = stringify({ sources: [fullSource()] }, { defaultStringType: 'QUOTE_DOUBLE', defaultKeyType: 'QUOTE_SINGLE' });
    expect(parseMapping(quoted, 'neburyx.yaml').sources[0]?.configHash).toBe(plain);
    const commented = `# header comment\n${reordered.replace('sources:', 'sources: # trailing')}\n\n`;
    expect(parseMapping(commented, 'neburyx.yaml').sources[0]?.configHash).toBe(plain);
  });

  const changes: readonly [string, Json][] = [
    ['an entity label', withEntity({ label: 'Renamed' })],
    ['an entity title', withEntity({ title: 'Item {id}' })],
    ['a searchable property', withEntity({ search: ['name', 'code'] })],
    ['a display icon', withDisplay({ icon: 'shield' })],
    ['a key property', withDisplay({ key_properties: ['status'] })],
    ['a state property', withDisplay({ state_property: 'other' })],
    ['an entity link', withEntity({ link: 'https://records.example.test/other/{id}' })],
    ['a relationship property', withRelationship({ observed_at: 'seenAt' })],
    ['an evidence link', withRelationship({ evidence_link: 'https://audit.example.test/other/{recordId}' })],
    ['a derived rule', fullSource({ derived: [{ id: 'shared', from: 'node_a', to: 'node_a', via: ['LINKS', 'node_b', 'LINKS'], rule_version: 2 }] })],
    ['a pattern preset', fullSource({ patterns: [{ id: 'p', name: 'Renamed', template: 'shared-attribute', bind: { anchor: 'node_a', attribute: 'node_b', via: 'LINKS' } }] })],
    ['the vocabulary', fullSource({ vocabulary: { case_ref: 'Alert' } })],
    ['the style section', fullSource({ style_rules: [{ id: 'other' }] })],
    ['the synthetic flag', fullSource({ synthetic: true })],
    ['a budget', fullSource({ budgets: { max_hops: 3 } })],
    ['the address', fullSource({ uri: 'neo4j+s://other.example.test:7687' })],
    ['the database', fullSource({ database: 'other' })],
    ['the credential variables', fullSource({ auth: { kind: 'basic', username_env: 'OTHER_USER', password_env: 'DEMO_PASSWORD' } })],
  ];

  it.each(changes)('differs after a change to %s', (_name, changed) => {
    expect(hashOf(changed)).not.toBe(hashOf(fullSource()));
  });

  it('differs when only the type of an unreferenced entity changes', () => {
    const spare = (type: string): Json =>
      fullSource({ entities: [fullEntity, { type: 'node_b', label: 'NodeB', stable_id: 'key' }, { type, label: 'Spare', stable_id: 'id' }] });
    expect(hashOf(spare('node_x'))).not.toBe(hashOf(spare('node_y')));
  });

  it('differs when only the type of an unreferenced relationship changes', () => {
    const spare = (type: string): Json => fullSource({ relationships: [fullRelationship, { type, from: 'node_b', to: 'node_b' }] });
    expect(hashOf(spare('SPARE_ONE'))).not.toBe(hashOf(spare('SPARE_TWO')));
  });

  it('keeps and distinguishes style entries that use the key __proto__', () => {
    const withRule = (value: string): string => `${fileOf(baseSource())}    style_rules: [{__proto__: ${value}}, {nested: {__proto__: ${value}}}]\n`;
    const one = parseMapping(withRule('one'), 'neburyx.yaml').sources[0];
    const two = parseMapping(withRule('two'), 'neburyx.yaml').sources[0];
    expect(Object.getOwnPropertyNames(one?.styleRules[0] ?? {})).toEqual(['__proto__']);
    expect(Object.getOwnPropertyNames(Object.getOwnPropertyDescriptor(one?.styleRules[1] ?? {}, 'nested')?.value ?? {})).toEqual(['__proto__']);
    expect(one?.configHash).not.toBe(two?.configHash);
  });

  it('leaves a source unchanged when another source in the file changes', () => {
    const one = baseSource({ id: 'one' });
    const before = parseMapping(fileOf(one, baseSource({ id: 'two' })), 'neburyx.yaml').sources[0]?.configHash;
    const after = parseMapping(fileOf(one, baseSource({ id: 'two', synthetic: true })), 'neburyx.yaml').sources[0]?.configHash;
    expect(after).toBe(before);
  });

  it('equals the hash of the file that omits a defaulted value', () => {
    const omitted = hashOf(baseSource());
    const explicit = hashOf(
      baseSource({
        synthetic: false,
        budgets: { timeout_ms: 5000, max_page: 50, default_page: 25, max_hops: 4, path_results_cap: 25, user_concurrency: 2, source_concurrency: 32, queue_wait_ms: 2000, heavy_op_threshold: 500 },
        entities: [
          { type: 'node_a', label: 'NodeA', stable_id: 'id', title: '{id}', display: { icon: 'generic', key_properties: ['id'] } },
          { type: 'node_b', label: 'NodeB', stable_id: 'key' },
        ],
      }),
    );
    expect(explicit).toBe(omitted);
  });

  it('is a SHA-256 hex digest', () => {
    expect(hashOf(baseSource())).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('hostile keys', () => {
  const style = '    style_rules: [{__proto__: {polluted: yes}, constructor: {prototype: {polluted: yes}}, prototype: {polluted: yes}}]\n';
  const presets = [
    '    patterns:',
    '      - id: p',
    '        name: P',
    '        template: shared-attribute',
    '        bind: {anchor: node_a, attribute: node_b, via: LINKS}',
    '        labels: {__proto__: {polluted: yes}, constructor: C, prototype: P}',
    '',
  ].join('\n');

  it('refuses a map value that is not text, so a hostile label never becomes an object', () => {
    expect(() => parseMapping(`${fileOf(baseSource())}${presets}`, 'neburyx.yaml')).toThrow('must be a map of non-empty text values');
  });

  it('keeps __proto__, constructor and prototype as own data on null-prototype objects and pollutes nothing', () => {
    const labelled = presets.replace('{__proto__: {polluted: yes}, constructor: C, prototype: P}', '{__proto__: A, constructor: C, prototype: P}');
    const source = parseMapping(`${fileOf(baseSource())}${style}${labelled}`, 'neburyx.yaml').sources[0];
    const [rule] = source?.styleRules ?? [];
    expect(Object.getPrototypeOf(rule)).toBeNull();
    expect(Object.getOwnPropertyNames(rule).sort()).toEqual(['__proto__', 'constructor', 'prototype']);
    const labels = source?.presets[0]?.labels ?? {};
    expect(Object.getPrototypeOf(labels)).toBeNull();
    expect(Object.getOwnPropertyNames(labels).sort()).toEqual(['__proto__', 'constructor', 'prototype']);
    expect(Reflect.get({}, 'polluted')).toBeUndefined();
    expect(Reflect.get(Object.prototype, 'polluted')).toBeUndefined();
    expect(Reflect.get(Object.prototype, 'prototype')).toBeUndefined();
  });
});

describe('fixed hash vectors', () => {
  it.each([
    [{ b: 1, a: [true, null, 'x'] }, '{"a":[true,null,"x"],"b":1}'],
    [{ z: { y: 'é', x: [] }, a: undefined }, '{"z":{"x":[],"y":"é"}}'],
    [[{ k: 'v' }, 2, 'three'], '[{"k":"v"},2,"three"]'],
    ['quote"and\\slash', '"quote\\"and\\\\slash"'],
  ])('writes %j as the same canonical text every time', (value, expected) => {
    expect(canonicalText(value)).toBe(expected);
  });

  it('gives a fixed digest for a fixed mapping, so the hash cannot change silently', () => {
    expect(hashOf(baseSource())).toBe('7f64d76ec7da1d267bcd7e31efdbfbebc0169b61472d7db802e5e503b979acba');
  });
});
