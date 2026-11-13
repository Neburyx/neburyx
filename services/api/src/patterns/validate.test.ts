import type { PatternProblem } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { parseMapping } from '../mapping/load.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { allowlistFromMapping } from '../gate/allowlist.js';
import { validatePattern } from './validate.js';

const ENTITIES = [
  { type: 'maker', label: 'Maker', stable_id: 'makerId', search: ['makerId', 'nickname'], filterable: ['grade', 'region'], pii: [{ property: 'ownerName', class: 'name' }, { property: 'region', class: 'text' }] },
  { type: 'tool', label: 'Tool', stable_id: 'toolId', search: ['toolId'], filterable: ['kind'] },
  { type: 'shop', label: 'Shop', stable_id: 'shopId', search: ['shopId', 'note'], filterable: ['town'] },
];
const RELATIONSHIPS = [
  { type: 'LINKS', from: 'maker', to: 'maker', stable_id: 'linkId', observed_at: 'seenAt', evidence: ['recordId'], filterable: ['weight'] },
  { type: 'KNOWS', from: 'maker', to: 'maker', filterable: ['closeness'] },
  { type: 'USES_TOOL', from: 'maker', to: 'tool', stable_id: 'useId' },
  { type: 'STOCKED_AT', from: 'tool', to: 'shop' },
];
const source = parseMapping(fileOf(baseSource({ id: 'demo', entities: ENTITIES, relationships: RELATIONSHIPS })), 'neburyx.yaml').sources[0];
if (source === undefined) throw new Error('no source');

const step = (extra: Record<string, unknown> = {}) => ({ relationshipTypes: ['LINKS'], direction: 'out', arrivesAt: 'maker', ...extra });
const definition = (steps: readonly unknown[] = [step()], extra: Record<string, unknown> = {}) => ({ anchorType: 'maker', steps, ...extra });
const on = (kind: 'neighbor' | 'relationship', property: string) => ({ op: 'eq', on: kind, property, value: { kind: 'text', value: 'a' } });
const check = (value: unknown, mask?: boolean): PatternProblem[] => validatePattern(value, source, { mask });

describe('a valid pattern', () => {
  it('has no problem: one step, a list of types, each direction, two steps, conditions that are filterable, a window', () => {
    expect(check(definition())).toEqual([]);
    expect(check(definition([step({ relationshipTypes: ['LINKS', 'KNOWS'] })]))).toEqual([]);
    expect(check(definition([step({ direction: 'in' }), step({ relationshipTypes: ['USES_TOOL'], arrivesAt: 'tool' })]))).toEqual([]);
    expect(check(definition([step({ relationshipTypes: ['USES_TOOL'], arrivesAt: 'tool', direction: 'both' })]))).toEqual([]);
    expect(check(definition([step({ conditions: [on('neighbor', 'grade'), on('relationship', 'weight'), on('relationship', 'seenAt')], window: { days: 30 } })]))).toEqual([]);
    expect(check(definition([step({ relationshipTypes: ['KNOWS'], conditions: [on('relationship', 'closeness')] })]))).toEqual([]);
  });
});

describe('a type the mapping does not name', () => {
  it('is unknown-entity-type at the anchor or at the step that arrives at it, and unknown-relationship-type at the type', () => {
    expect(check({ ...definition(), anchorType: 'nothing' })).toEqual([{ path: ['anchorType'], code: 'unknown-entity-type' }]);
    expect(check(definition([step({ arrivesAt: 'nothing' })]))).toEqual([{ path: ['steps', 0, 'arrivesAt'], code: 'unknown-entity-type' }]);
    expect(check(definition([step({ relationshipTypes: ['LINKS', 'NOTHING'] })]))).toEqual([{ path: ['steps', 0, 'relationshipTypes', 1], code: 'unknown-relationship-type' }]);
    expect(check(definition([step({ relationshipTypes: ['links'] })]))).toEqual([{ path: ['steps', 0, 'relationshipTypes', 0], code: 'unknown-relationship-type' }]);
    expect(check(definition([step({ arrivesAt: 'Maker' })]))).toEqual([{ path: ['steps', 0, 'arrivesAt'], code: 'unknown-entity-type' }]);
  });
});

describe('a step that does not join the previous node type in the stated direction', () => {
  it('is relationship-does-not-join at the type, for each type listed', () => {
    expect(check(definition([step({ relationshipTypes: ['USES_TOOL'], arrivesAt: 'maker' })]))).toEqual([{ path: ['steps', 0, 'relationshipTypes', 0], code: 'relationship-does-not-join' }]);
    expect(check(definition([step({ relationshipTypes: ['USES_TOOL'], arrivesAt: 'tool', direction: 'in' })]))).toEqual([{ path: ['steps', 0, 'relationshipTypes', 0], code: 'relationship-does-not-join' }]);
    expect(check(definition([step({ relationshipTypes: ['LINKS', 'USES_TOOL'], arrivesAt: 'tool' })]))).toEqual([{ path: ['steps', 0, 'relationshipTypes', 0], code: 'relationship-does-not-join' }]);
    expect(check(definition([step({ relationshipTypes: ['USES_TOOL'], arrivesAt: 'tool' }), step({ relationshipTypes: ['LINKS'], arrivesAt: 'maker' })]))).toEqual([{ path: ['steps', 1, 'relationshipTypes', 0], code: 'relationship-does-not-join' }]);
    expect(check(definition([step({ relationshipTypes: ['STOCKED_AT'], arrivesAt: 'shop' })]))).toEqual([{ path: ['steps', 0, 'relationshipTypes', 0], code: 'relationship-does-not-join' }]);
  });

  it('is checked from the node the previous step arrived at, and not for a type that is unknown (no second problem for the same fault)', () => {
    expect(check(definition([step({ relationshipTypes: ['USES_TOOL'], arrivesAt: 'tool' }), step({ relationshipTypes: ['STOCKED_AT'], arrivesAt: 'shop' })]))).toEqual([]);
    expect(check(definition([step({ arrivesAt: 'nothing' })]))).toEqual([{ path: ['steps', 0, 'arrivesAt'], code: 'unknown-entity-type' }]);
  });
});

describe('a condition', () => {
  it('on a property the mapping does not name for the node type is unknown-property, and one it names and does not declare filterable is not-filterable', () => {
    expect(check(definition([step({ conditions: [on('neighbor', 'zzz')] })]))).toEqual([{ path: ['steps', 0, 'conditions', 0, 'property'], code: 'unknown-property' }]);
    expect(check(definition([step({ conditions: [on('neighbor', 'nickname')] })]))).toEqual([{ path: ['steps', 0, 'conditions', 0, 'property'], code: 'not-filterable' }]);
    expect(check(definition([step({ conditions: [on('neighbor', 'makerId')] })]))).toEqual([{ path: ['steps', 0, 'conditions', 0, 'property'], code: 'not-filterable' }]);
    expect(check(definition([step({ relationshipTypes: ['USES_TOOL'], arrivesAt: 'tool', conditions: [on('neighbor', 'grade')] })]))).toEqual([{ path: ['steps', 0, 'conditions', 0, 'property'], code: 'unknown-property' }]);
  });

  it('on a relationship is checked against every row the step reads: one row that lacks the property is enough, and the observed time counts as filterable', () => {
    expect(check(definition([step({ conditions: [on('relationship', 'zzz')] })]))).toEqual([{ path: ['steps', 0, 'conditions', 0, 'property'], code: 'unknown-property' }]);
    expect(check(definition([step({ conditions: [on('relationship', 'recordId')] })]))).toEqual([{ path: ['steps', 0, 'conditions', 0, 'property'], code: 'not-filterable' }]);
    expect(check(definition([step({ relationshipTypes: ['LINKS', 'KNOWS'], conditions: [on('relationship', 'weight')] })]))).toEqual([{ path: ['steps', 0, 'conditions', 0, 'property'], code: 'unknown-property' }]);
    expect(check(definition([step({ relationshipTypes: ['LINKS', 'KNOWS'], conditions: [on('relationship', 'closeness')] })]))).toEqual([{ path: ['steps', 0, 'conditions', 0, 'property'], code: 'unknown-property' }]);
    expect(check(definition([step({ relationshipTypes: ['LINKS'], conditions: [on('relationship', 'seenAt')] })]))).toEqual([]);
  });

  it('on a personal-data property of the node is personal-data-masked only while masking is asked, and a relationship condition never is', () => {
    const personal = definition([step({ conditions: [on('neighbor', 'region')] })]);
    expect(check(personal)).toEqual([]);
    expect(check(personal, false)).toEqual([]);
    expect(check(personal, true)).toEqual([{ path: ['steps', 0, 'conditions', 0, 'property'], code: 'personal-data-masked' }]);
    expect(check(definition([step({ conditions: [on('relationship', 'weight')] })]), true)).toEqual([]);
    expect(check(definition([step({ conditions: [on('neighbor', 'ownerName')] })]), true)).toEqual([{ path: ['steps', 0, 'conditions', 0, 'property'], code: 'not-filterable' }]);
  });
});

describe('a window', () => {
  it('over relationship types with no mapped time property is accepted: the run says it did not apply', () => {
    expect(check(definition([step({ relationshipTypes: ['KNOWS'], window: { days: 7 } })]))).toEqual([]);
    expect(check(definition([step({ relationshipTypes: ['USES_TOOL'], arrivesAt: 'tool', window: { from: '2026-01-01', to: '2026-01-31' } })]))).toEqual([]);
  });
});

describe('the problems', () => {
  it('are all returned, in the order of the definition, with a path at the element at fault and no name or value of the definition', () => {
    const sentinel = 'SENTINEL-NAME';
    const bad = definition([
      step({ relationshipTypes: [sentinel], arrivesAt: sentinel, conditions: [on('neighbor', sentinel)] }),
      step({ relationshipTypes: ['USES_TOOL'], arrivesAt: 'maker', conditions: [on('relationship', sentinel)] }),
    ], { anchorType: sentinel });
    const found = check(bad);
    expect(found.map((problem) => `${problem.path.join('.')}:${problem.code}`)).toEqual(['anchorType:unknown-entity-type', 'steps.0.arrivesAt:unknown-entity-type', 'steps.0.relationshipTypes.0:unknown-relationship-type']);
    const joinFault = check(definition([step(), step({ relationshipTypes: ['USES_TOOL'], arrivesAt: 'maker', conditions: [on('neighbor', 'zzz')] })]));
    expect(joinFault.map((problem) => `${problem.path.join('.')}:${problem.code}`)).toEqual(['steps.1.relationshipTypes.0:relationship-does-not-join', 'steps.1.conditions.0.property:unknown-property']);
    expect(JSON.stringify(found)).not.toContain(sentinel);
  });

  it('are the schema\'s own, alone, when the definition is not well formed; and the validator needs the mapping and nothing else', () => {
    expect(check({ anchorType: 'maker', steps: [] })).toEqual([{ path: ['steps'], code: 'too-few' }]);
    expect(check({ anchorType: 'maker', steps: [step({ arrivesAt: 'nothing', direction: 'up' })] })).toEqual([{ path: ['steps', 0, 'direction'], code: 'bad-value' }]);
    expect(validatePattern.length).toBeLessThanOrEqual(3);
  });
});

describe('property kinds in the mapping', () => {
  it('leave the problems of a pattern unchanged: the same definitions give the same problems with and without kinds', () => {
    const kinded = parseMapping(fileOf(baseSource({ id: 'demo', entities: ENTITIES.map((entity) => (entity.type === 'maker' ? { ...entity, kinds: { grade: 'number', region: 'text' } } : entity)), relationships: RELATIONSHIPS.map((row) => (row.type === 'LINKS' ? { ...row, kinds: { weight: 'number' } } : row)) })), 'neburyx.yaml').sources[0];
    if (kinded === undefined) throw new Error('no source');
    const samples = [definition(), definition([step({ conditions: [on('neighbor', 'grade'), on('relationship', 'weight')] })]), definition([step({ conditions: [on('neighbor', 'nothing')] })]), { ...definition(), anchorType: 'nothing' }];
    for (const sample of samples) expect(validatePattern(sample, kinded)).toEqual(validatePattern(sample, source));
  });

  it('leave the allowlist the statements are written from unchanged', () => {
    const kinded = parseMapping(fileOf(baseSource({ id: 'demo', entities: ENTITIES.map((entity) => ({ ...entity, kinds: Object.fromEntries((entity.filterable ?? []).map((property) => [property, 'text'])) })), relationships: RELATIONSHIPS })), 'neburyx.yaml').sources[0];
    if (kinded === undefined) throw new Error('no source');
    expect(allowlistFromMapping(kinded)).toEqual(allowlistFromMapping(source));
  });
});
