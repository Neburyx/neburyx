import { describe, expect, it } from 'vitest';
import { baseSource, expectRefused, firstSource, issuesOf, fileOf, load, type Json } from '../testing/mapping.js';
import { MAX_PATTERN_DESCRIPTION, MAX_PATTERN_GROUP, MAX_PATTERN_TAG } from './schema.js';

const entities: Json[] = [
  { type: 'node_a', label: 'NodeA', stable_id: 'id' },
  { type: 'node_b', label: 'NodeB', stable_id: 'key' },
];
const relationships: Json[] = [
  { type: 'SENT', from: 'node_a', to: 'node_a', observed_at: 'at' },
  { type: 'UNTIMED', from: 'node_a', to: 'node_a' },
  { type: 'USES', from: 'node_a', to: 'node_b' },
];
const step = (extra: Json = {}): Json => ({ relationshipTypes: ['SENT'], direction: 'out', arrivesAt: 'node_a', ...extra });
const definition = (...steps: Json[]): Json => ({ anchorType: 'node_a', steps });
const sourceWith = (patterns: Json[], extra: Json = {}): Json => baseSource({ entities, relationships, patterns, ...extra });
const entry = (over: Json = {}): Json => ({ id: 'fan-out', name: 'Fan-out', definition: definition(step({ fan: { atLeast: 10 } })), ...over });
const PRESET: Json = { id: 'shared', name: 'Shared', template: 'shared-attribute', bind: { anchor: 'node_a', attribute: 'node_b', via: 'USES' } };

describe('a built-in definition in the mapping', () => {
  it('loads with its sentence, section and tag, and goes to its own list, leaving the presets as they were', () => {
    const source = firstSource(load(sourceWith([PRESET, entry({ description: 'One account sends to many accounts.', group: 'AML typologies', tag: 'AML' })])));
    expect(source.presets.map((preset) => preset.id)).toEqual(['shared']);
    expect(source.builtInDefinitions).toEqual([{ id: 'fan-out', name: 'Fan-out', definition: definition(step({ fan: { atLeast: 10 } })), description: 'One account sends to many accounts.', group: 'AML typologies', tag: 'AML' }]);
  });

  it('keeps every entry in the mapping’s order and takes a definition with all three kinds', () => {
    const cycle = entry({ id: 'cycle', name: 'Cycle', definition: definition(step(), step(), step({ closesAtAnchor: true })) });
    const ordered = entry({ id: 'ordered', name: 'Ordered', definition: definition(step(), step({ after: 'previous' })) });
    const source = firstSource(load(sourceWith([entry(), cycle, ordered])));
    expect(source.builtInDefinitions?.map((item) => item.id)).toEqual(['fan-out', 'cycle', 'ordered']);
  });

  it('has no list at all when the mapping declares none, so the hash of such a mapping is the one the loader gave before built-in definitions existed (pinned)', () => {
    const plain = firstSource(load(sourceWith([PRESET])));
    expect('builtInDefinitions' in plain).toBe(false);
    expect(plain.configHash).toBe('7ba50c4e3e8f8b33f62f638e8d7d84adac8d6bd9dc205411d1fd1c7c83f93861');
  });

  it('changes the hash when a definition changes, its text or its number', () => {
    const a = firstSource(load(sourceWith([entry()]))).configHash;
    const b = firstSource(load(sourceWith([entry({ definition: definition(step({ fan: { atLeast: 11 } })) })]))).configHash;
    const c = firstSource(load(sourceWith([entry({ description: 'x' })]))).configHash;
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it.each([
    ['a definition and a template', entry({ template: 'shared-attribute', bind: { anchor: 'node_a', attribute: 'node_b', via: 'USES' } }), 'sources[0].patterns[0]', 'one or the other'],
    ['a definition and labels', entry({ labels: { anchor: 'x' } }), 'sources[0].patterns[0]', 'one or the other'],
    ['neither', { id: 'x', name: 'X' }, 'sources[0].patterns[0]', 'needs a template and bind, or a definition'],
    ['a sentence on a preset', { ...PRESET, description: 'no' }, 'sources[0].patterns[0]', 'only a pattern with a definition has'],
    ['an id that is a template name', entry({ id: 'shared-attribute' }), 'sources[0].patterns[0].id', 'may not use as its ID'],
    ['a sentence over its limit', entry({ description: 'x'.repeat(MAX_PATTERN_DESCRIPTION + 1) }), 'sources[0].patterns[0].description', ''],
    ['a section over its limit', entry({ group: 'x'.repeat(MAX_PATTERN_GROUP + 1) }), 'sources[0].patterns[0].group', ''],
    ['a tag over its limit', entry({ tag: 'x'.repeat(MAX_PATTERN_TAG + 1) }), 'sources[0].patterns[0].tag', ''],
    ['a key that is not listed', entry({ query: 'MATCH (n) RETURN n' }), 'sources[0].patterns[0].query', ''],
  ])('is refused when it has %s', (_label, bad, path, reason) => {
    const issue = expectRefused(sourceWith([bad]), path, reason);
    expect(issue.path).toBe(path);
  });

  it('is refused when an id is used twice across both kinds, naming the pattern', () => {
    expectRefused(sourceWith([PRESET, entry({ id: 'shared' })]), 'sources[0].patterns[1].id', 'repeats pattern shared');
  });

  it.each([
    ['an unknown type', entry({ definition: definition(step({ arrivesAt: 'nothing' })) }), 'sources[0].patterns[0].definition.steps[0].arrivesAt', 'unknown-entity-type'],
    ['a relationship that does not join', entry({ definition: definition(step({ relationshipTypes: ['USES'] })) }), 'sources[0].patterns[0].definition.steps[0].relationshipTypes[0]', 'relationship-does-not-join'],
    ['a time order on a row with no time', entry({ definition: definition(step(), step({ relationshipTypes: ['UNTIMED'], after: 'previous' })) }), 'sources[0].patterns[0].definition.steps[1].after', 'time-not-mapped'],
    ['a fan above the count cap', entry({ definition: definition(step({ fan: { atLeast: 600 } })) }), 'sources[0].patterns[0].definition.steps[0].fan.atLeast', 'over-ceiling'],
    ['a cycle longer than the source allows', entry({ definition: definition(step(), step(), step({ closesAtAnchor: true })) }), 'sources[0].patterns[0].definition.steps', 'cycle-too-long'],
    ['a field the definition does not have', entry({ definition: { anchorType: 'node_a', steps: [step({ cypher: 'MATCH (n)' })] } }), 'sources[0].patterns[0].definition.steps[0]', 'unknown-key'],
  ])('stops the load for %s with the validator’s code at its path, and no value', (_label, bad, path, code) => {
    const extra = code === 'cycle-too-long' ? { budgets: { max_hops: 2 } } : {};
    const issues = issuesOf(fileOf(sourceWith([bad], extra)));
    expect(issues.some((issue) => issue.path === path && issue.reason.includes(code)), JSON.stringify(issues)).toBe(true);
    expect(JSON.stringify(issues)).not.toContain('MATCH');
  });
});
