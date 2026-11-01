import { describe, expect, it } from 'vitest';
import { baseSource, expectRefused, fileOf, firstSource, issuesOf, load, type Json } from '../testing/mapping.js';
import { parseMapping } from './load.js';

const entities = [
  { type: 'node_a', label: 'NodeA', stable_id: 'id' },
  { type: 'node_b', label: 'NodeB', stable_id: 'key' },
];
const relationships = [{ type: 'LINKS', from: 'node_a', to: 'node_b' }];
const rule = { id: 'shared', from: 'node_a', to: 'node_a', via: ['LINKS', 'node_b', 'LINKS'], rule_version: 1, stop_list_property: 'isShared' };

function withRule(overrides: Json): Json {
  return baseSource({ entities, relationships, derived: [{ ...rule, ...overrides }] });
}

describe('derived-edge rules', () => {
  it('holds a rule as written', () => {
    expect(firstSource(load(withRule({}))).derived[0]).toEqual({
      id: 'shared',
      from: 'node_a',
      to: 'node_a',
      via: ['LINKS', 'node_b', 'LINKS'],
      ruleVersion: 1,
      stopListProperty: 'isShared',
    });
  });

  it('allows a rule without a stop-list property', () => {
    expect(firstSource(load(withRule({ stop_list_property: undefined }))).derived[0]?.stopListProperty).toBeUndefined();
  });

  it.each([
    ['rule_version of the wrong type', { rule_version: 'one' }, 'sources[0].derived[0].rule_version', 'must be number'],
    ['a rule_version below one', { rule_version: 0 }, 'sources[0].derived[0].rule_version', 'must be at least 1'],
    ['a fractional rule_version', { rule_version: 1.5 }, 'sources[0].derived[0].rule_version', 'must be'],
    ['a from that is not mapped', { from: 'missing' }, 'sources[0].derived[0].from', 'names missing'],
    ['a to that is not mapped', { to: 'missing' }, 'sources[0].derived[0].to', 'names missing'],
    ['a via that is too short', { via: ['LINKS'] }, 'sources[0].derived[0].via', 'odd number of entries'],
    ['a via of even length', { via: ['LINKS', 'node_b'] }, 'sources[0].derived[0].via', 'odd number of entries'],
    ['an unmapped relationship entry', { via: ['MISSING', 'node_b', 'LINKS'] }, 'sources[0].derived[0].via[0]', 'names MISSING'],
    ['an unmapped entity entry', { via: ['LINKS', 'missing', 'LINKS'] }, 'sources[0].derived[0].via[1]', 'names missing'],
    ['an entity type in a relationship position', { via: ['node_b', 'node_b', 'LINKS'] }, 'sources[0].derived[0].via[0]', 'is not a relationship type'],
  ])('refuses %s', (_name, overrides, path, reason) => {
    expectRefused(withRule(overrides), path, reason, 'source demo, derived rule shared');
  });

  it('names the source of a rule that has no ID', () => {
    expectRefused(withRule({ id: undefined }), 'sources[0].derived[0].id', 'is required', 'source demo');
  });

  it('refuses two rules with the same ID in one source, and allows it across sources', () => {
    expectRefused(baseSource({ entities, relationships, derived: [rule, rule] }), 'sources[0].derived[1].id', 'repeats derived rule shared');
    const text = fileOf(baseSource({ id: 'one', entities, relationships, derived: [rule] }), baseSource({ id: 'two', entities, relationships, derived: [rule] }));
    expect(parseMapping(text, 'neburyx.yaml').sources).toHaveLength(2);
  });

  it('refuses a rule that names a type mapped only in another source', () => {
    const other = baseSource({ id: 'other', entities: [{ type: 'elsewhere', label: 'E', stable_id: 'id' }], relationships: undefined });
    const issues = issuesOf(fileOf(withRule({ from: 'elsewhere' }), other));
    expect(issues.some((issue) => issue.path === 'sources[0].derived[0].from')).toBe(true);
  });
});

const sharedPreset = { id: 'one', name: 'Shared', template: 'shared-attribute', bind: { anchor: 'node_a', attribute: 'node_b', via: 'LINKS' }, labels: { anchor: 'Start' } };
const linkedPreset = { id: 'two', name: 'Linked', template: 'linked-entities', bind: { anchor: 'node_a', target: 'node_b', via: 'LINKS' } };

function withPresets(...patterns: Json[]): Json {
  return baseSource({ entities, relationships, patterns });
}

describe('pattern presets', () => {
  it('holds a preset of each template', () => {
    const presets = firstSource(load(withPresets(sharedPreset, linkedPreset))).presets;
    expect(presets).toEqual([
      { id: 'one', name: 'Shared', template: 'shared-attribute', bind: sharedPreset.bind, labels: { anchor: 'Start' } },
      { id: 'two', name: 'Linked', template: 'linked-entities', bind: linkedPreset.bind, labels: {} },
    ]);
  });

  it.each([
    ['a template that is not built in', { template: 'free-form' }, 'sources[0].patterns[0].template', 'must be one of'],
    ['a missing bind key', { bind: { anchor: 'node_a', via: 'LINKS' } }, 'sources[0].patterns[0].bind', 'is missing attribute'],
    ['an extra bind key', { bind: { ...sharedPreset.bind, target: 'node_b' } }, 'sources[0].patterns[0].bind.target', 'is not a binding of shared-attribute'],
    ['an unmapped entity type', { bind: { ...sharedPreset.bind, anchor: 'missing' } }, 'sources[0].patterns[0].bind.anchor', 'names missing'],
    ['an unmapped relationship type', { bind: { ...sharedPreset.bind, via: 'MISSING' } }, 'sources[0].patterns[0].bind.via', 'names MISSING'],
    ['a relationship type bound as an entity', { bind: { ...sharedPreset.bind, attribute: 'LINKS' } }, 'sources[0].patterns[0].bind.attribute', 'is not an entity type'],
    ['a missing name', { name: undefined }, 'sources[0].patterns[0].name', 'is required'],
  ])('refuses a preset with %s', (_name, overrides, path, reason) => {
    expectRefused(withPresets({ ...sharedPreset, ...overrides }), path, reason, 'source demo, pattern one');
  });

  it('refuses a bind key named __proto__ and keeps a label named __proto__', () => {
    const text = `${fileOf(baseSource({ entities, relationships }))}    patterns:\n      - id: p\n        name: P\n        template: shared-attribute\n        bind: {anchor: node_a, attribute: node_b, via: LINKS, __proto__: node_a}\n`;
    expect(issuesOf(text).some((issue) => issue.path === 'sources[0].patterns[0].bind.__proto__' && issue.reason.includes('is not a binding'))).toBe(true);
    const labelled = `${fileOf(baseSource({ entities, relationships }))}    patterns:\n      - id: p\n        name: P\n        template: shared-attribute\n        bind: {anchor: node_a, attribute: node_b, via: LINKS}\n        labels: {__proto__: First}\n`;
    const labels = parseMapping(labelled, 'neburyx.yaml').sources[0]?.presets[0]?.labels ?? {};
    expect(Object.getOwnPropertyNames(labels)).toEqual(['__proto__']);
    const other = parseMapping(labelled.replace('First', 'Second'), 'neburyx.yaml').sources[0];
    expect(other?.configHash).not.toBe(parseMapping(labelled, 'neburyx.yaml').sources[0]?.configHash);
  });

  it('refuses bind or labels that are not maps of text', () => {
    expectRefused(withPresets({ ...sharedPreset, labels: ['x'] }), 'sources[0].patterns[0].labels', 'must be a map');
    expectRefused(withPresets({ ...sharedPreset, bind: { ...sharedPreset.bind, via: '' } }), 'sources[0].patterns[0].bind', 'must be a map');
  });

  it('refuses a linked-entities preset that uses the shared-attribute keys', () => {
    expectRefused(withPresets({ ...linkedPreset, bind: sharedPreset.bind }), 'sources[0].patterns[0].bind.attribute', 'is not a binding of linked-entities');
  });

  it('refuses two presets with the same ID in one source', () => {
    expectRefused(withPresets(sharedPreset, { ...linkedPreset, id: 'one' }), 'sources[0].patterns[1].id', 'repeats pattern one');
  });
});

describe('vocabulary and the style section', () => {
  it('holds the case reference label', () => {
    expect(firstSource(load(baseSource({ vocabulary: { case_ref: 'Referral' } }))).vocabulary).toEqual({ caseRef: 'Referral' });
  });

  it('has no vocabulary entries when omitted', () => {
    expect(firstSource(load(baseSource())).vocabulary).toEqual({});
  });

  it('refuses an empty case reference label', () => {
    expectRefused(baseSource({ vocabulary: { case_ref: '' } }), 'sources[0].vocabulary.case_ref', 'must not be empty');
  });

  it('keeps every style rule entry as written without interpreting it', () => {
    const rules = [{ id: 'r1', anything: ['goes', 1] }, 'opaque'];
    expect(firstSource(load(baseSource({ style_rules: rules }))).styleRules).toEqual(rules);
  });

  it.each([
    ['not-a-number', '[.nan]'],
    ['infinity', '[.inf]'],
  ])('refuses a style entry holding %s, which would not hash faithfully', (_name, rules) => {
    const issues = issuesOf(`${fileOf(baseSource())}    style_rules: ${rules}\n`);
    expect(issues.some((issue) => issue.path === 'sources[0].style_rules[0]' && issue.reason.includes('not plain data'))).toBe(true);
  });

  it.each([
    ['a set', '[!!set {a, b}]'],
    ['binary data', '[!!binary aGk=]'],
  ])('refuses a style entry holding %s, because tags are not allowed', (_name, rules) => {
    const issues = issuesOf(`${fileOf(baseSource())}    style_rules: ${rules}\n`);
    expect(issues.some((issue) => issue.reason.includes('uses a tag'))).toBe(true);
  });

  it('refuses a style section that is not a list', () => {
    expectRefused(baseSource({ style_rules: { id: 'r' } }), 'sources[0].style_rules', 'must be array');
  });
});
