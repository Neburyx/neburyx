import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MappingError } from './diagnostics.js';
import { loadMappingFile } from './load.js';
import { baseSource, expectRefused, fileOf, firstSource, issuesOf, load, styleRuleOf, type Json } from '../testing/mapping.js';

const entityA: Json = {
  type: 'node_a',
  label: 'NodeA',
  stable_id: 'id',
  pii: ['secret'],
  search: ['name'],
  filterable: ['score', 'when_at', 'note', 'flag', 'seen_on', 'clock'],
  kinds: { score: 'number', when_at: 'dateTime', note: 'text', flag: 'boolean', seen_on: 'date', clock: 'time' },
  display: { icon: 'document', key_properties: ['name'], state_property: 'status' },
};

const sourceWith = (...rules: Json[]): Json => baseSource({ entities: [entityA, { type: 'node_b', label: 'NodeB', stable_id: 'key' }], style_rules: rules });
const rule = (when: Json, effect: Json = { badge: 'amber' }, extra: Json = {}): Json => styleRuleOf({ when, effect, ...extra });

describe('style rules that load', () => {
  it('loads each operator and each effect kind, typed and in mapping order', () => {
    const rules = [
      rule({ property: 'status', op: 'eq', value: 'review' }, { badge: 'amber' }, { id: 'r1' }),
      rule({ property: 'status', op: 'in', value: ['a', 'b'] }, { color: 'red' }, { id: 'r2' }),
      rule({ property: 'score', op: 'gt', value: 2000 }, { size: 'larger' }, { id: 'r3' }),
      rule({ property: 'score', op: 'gte', value: 1 }, { icon: 'shield' }, { id: 'r4' }),
      rule({ property: 'score', op: 'lt', value: 5 }, { badge: 'gray' }, { id: 'r5' }),
      rule({ property: 'score', op: 'lte', value: 5 }, { color: 'green' }, { id: 'r6' }),
      rule({ property: 'score', op: 'between', value: [1, 9] }, { badge: 'blue' }, { id: 'r7' }),
      rule({ property: 'when_at', op: 'gte', value: '2026-01-01T00:00:00Z' }, { badge: 'red' }, { id: 'r8' }),
      rule({ property: 'seen_on', op: 'between', value: ['2026-01-01', '2026-02-01'] }, { badge: 'red' }, { id: 'r9' }),
      rule({ property: 'clock', op: 'lt', value: '12:00:00+01:00' }, { badge: 'red' }, { id: 'r10' }),
    ];
    const source = firstSource(load(sourceWith(...rules)));
    expect(source.styleRules.map((entry) => [entry.id, entry.when.op, entry.effect.kind])).toEqual([
      ['r1', 'eq', 'badge'], ['r2', 'in', 'color'], ['r3', 'gt', 'size'], ['r4', 'gte', 'icon'], ['r5', 'lt', 'badge'], ['r6', 'lte', 'color'], ['r7', 'between', 'badge'], ['r8', 'gte', 'badge'], ['r9', 'between', 'badge'], ['r10', 'lt', 'badge'],
    ]);
    expect(source.styleRules[6]?.when.values).toHaveLength(2);
  });

  it('gives a mapping without rules, or with an empty list, the hash it had, and a mapping with a rule another', () => {
    const none = firstSource(load(baseSource())).configHash;
    expect(firstSource(load(baseSource({ style_rules: [] }))).configHash).toBe(none);
    expect(firstSource(load(sourceWith(rule({ property: 'status', op: 'eq', value: 'x' })))).configHash).not.toBe(firstSource(load(sourceWith())).configHash);
  });

  it('accepts two ids that differ only in case, and one rule on each of two types', () => {
    const second = rule({ property: 'key', op: 'eq', value: 'k' }, { badge: 'amber' }, { id: 'R', applies_to: 'node_b' });
    expect(firstSource(load(sourceWith(rule({ property: 'status', op: 'eq', value: 'x' }, { badge: 'amber' }, { id: 'r' }), second))).styleRules).toHaveLength(2);
  });
});

describe('a style rule that is refused', () => {
  const at = 'sources[0].style_rules[0]';

  it('names the property marked personal data, with no value in the reason', () => {
    const issue = expectRefused(sourceWith(rule({ property: 'secret', op: 'eq', value: 'SUPPLIED_VALUE' })), `${at}.when.property`, 'personal-data property');
    expect(JSON.stringify(issue)).not.toContain('SUPPLIED_VALUE');
  });

  it('names a property that is not mapped for the type, and a type that is not an entity type', () => {
    expectRefused(sourceWith(rule({ property: 'unmapped', op: 'eq', value: 'x' })), `${at}.when.property`, 'not a property mapped');
    expectRefused(sourceWith(rule({ property: 'status', op: 'eq', value: 'x' }, { badge: 'amber' }, { applies_to: 'nowhere' })), `${at}.applies_to`, 'not an entity type');
  });

  it('refuses a relationship type, since style rules apply to entity types only', () => {
    expectRefused(sourceWith(rule({ property: 'status', op: 'eq', value: 'x' }, { badge: 'amber' }, { applies_to: 'LINKS' })), `${at}.applies_to`, 'entity types only');
  });

  it('refuses a repeated id and names the second rule', () => {
    const same = rule({ property: 'status', op: 'eq', value: 'x' });
    expectRefused(sourceWith(same, same), 'sources[0].style_rules[1].id', 'repeats');
  });

  it.each([
    ['a property that is not filterable', { property: 'status', op: 'gt', value: 1 }],
    ['a filterable property with no declared kind', { property: 'name', op: 'gt', value: 1 }],
    ['a text kind', { property: 'note', op: 'gte', value: 'a' }],
    ['a boolean kind', { property: 'flag', op: 'between', value: [false, true] }],
  ])('refuses an ordering operator on %s', (_name, when) => {
    const entity = { ...entityA, filterable: [...(entityA['filterable'] as string[]), 'name'] };
    expectRefused(baseSource({ entities: [entity, { type: 'node_b', label: 'NodeB', stable_id: 'key' }], style_rules: [rule(when)] }), `${at}.when.op`, 'filterable property with a declared kind');
  });

  it.each([
    ['a text for a number', { property: 'score', op: 'gt', value: 'many' }, `${at}.when.value`],
    ['a date of another shape', { property: 'seen_on', op: 'lt', value: '01/02/2026' }, `${at}.when.value`],
    ['a text longer than the limit', { property: 'note', op: 'eq', value: 'x'.repeat(257) }, `${at}.when.value`],
    ['an empty in list', { property: 'status', op: 'in', value: [] }, `${at}.when.value`],
    ['an in list over the limit', { property: 'status', op: 'in', value: Array.from({ length: 21 }, (_u, i) => `v${i}`) }, `${at}.when.value`],
    ['an in list of two kinds', { property: 'status', op: 'in', value: ['a', 1] }, `${at}.when.value`],
    ['a between with the low end above the high end', { property: 'score', op: 'between', value: [9, 1] }, `${at}.when.value`],
    ['a between of one value', { property: 'score', op: 'between', value: [1] }, `${at}.when.value`],
    ['a list for eq', { property: 'status', op: 'eq', value: ['a'] }, `${at}.when.value`],
    ['a missing value', { property: 'status', op: 'eq' }, `${at}.when.value`],
    ['an object for eq', { property: 'status', op: 'eq', value: { a: 1 } }, `${at}.when.value`],
  ])('refuses %s with the path and the reason', (_name, when, path) => {
    const issue = issuesOf(fileOf(sourceWith(rule(when)))).find((entry) => entry.path === path);
    expect(issue).toBeDefined();
    expect(issue?.reason).not.toMatch(/many|01\/02|xxxx/);
  });

  it.each([
    ['two effects', { badge: 'amber', color: 'red' }, `${at}.effect`],
    ['no effect', {}, `${at}.effect`],
    ['an unknown effect kind', { glow: 'amber' }, `${at}.effect.glow`],
    ['a tone outside the set', { badge: 'purple' }, `${at}.effect.badge`],
    ['an icon that is not an icon key', { icon: 'rocket' }, `${at}.effect.icon`],
    ['a size other than larger', { size: 'huge' }, `${at}.effect.size`],
  ])('refuses %s', (_name, effect, path) => {
    expect(issuesOf(fileOf(sourceWith(rule({ property: 'status', op: 'eq', value: 'x' }, effect)))).some((issue) => issue.path === path)).toBe(true);
  });

  it.each([
    ['an empty label', { label: '' }, `${at}.label`],
    ['a label over 80 characters', { label: 'x'.repeat(81) }, `${at}.label`],
    ['an unknown key in a rule', { colour: 'red' }, at],
    ['a label with a control character', { label: 'a\u0007b' }, `${at}.label`],
  ])('refuses %s', (_name, extra, path) => {
    expect(issuesOf(fileOf(sourceWith(rule({ property: 'status', op: 'eq', value: 'x' }, { badge: 'amber' }, extra)))).some((issue) => issue.path.startsWith(path))).toBe(true);
  });

  it('refuses a style section that is not a list, and a rule that is not a map', () => {
    expectRefused(baseSource({ style_rules: { id: 'r' } }), 'sources[0].style_rules', 'must be array');
    expect(issuesOf(fileOf(baseSource({ style_rules: ['opaque'] }))).some((issue) => issue.path === at)).toBe(true);
  });

  it('refuses a rule in the loaded file as every other mapping error, so no source is served', () => {
    expect(() => load(sourceWith(rule({ property: 'secret', op: 'eq', value: 'x' })))).toThrow();
  });

  it('is refused from a file by the loader that `test-source`, the migration and the API share, with the same issue', () => {
    const folder = mkdtempSync(join(tmpdir(), 'style-rules-'));
    try {
      const file = join(folder, 'neburyx.yaml');
      writeFileSync(file, fileOf(sourceWith(rule({ property: 'secret', op: 'eq', value: 'x' }))));
      let thrown: unknown;
      try {
        loadMappingFile(file);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(MappingError);
      expect((thrown as MappingError).issues.some((issue) => issue.path === 'sources[0].style_rules[0].when.property')).toBe(true);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
