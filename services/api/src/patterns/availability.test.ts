import { describe, expect, it } from 'vitest';
import { LINKED_PRESET } from '../testing/linked-entities-fixtures.js';
import { PATTERN_ENTITIES, PATTERN_RELATIONSHIPS } from '../testing/pattern-fixtures.js';
import { SHARED_PRESET } from '../testing/shared-attribute-fixtures.js';
import { SAVED_DEFINITION, definitionRow, presetRow, savedMappingOf } from '../testing/saved-pattern-fixtures.js';
import { availabilityOf } from './availability.js';

const sourceOf = (parts: Parameters<typeof savedMappingOf>[0] = {}) => {
  const [source] = savedMappingOf(parts).sources;
  if (source === undefined) throw new Error('no source');
  return source;
};
const codesOf = (answer: ReturnType<typeof availabilityOf>): string[] => (answer.status === 'available' ? [] : answer.reasons.map((reason) => reason.code));
const without = (type: string) => PATTERN_RELATIONSHIPS.filter((row) => row.type !== type);

describe('the availability of a saved definition', () => {
  it('is available when the mapping still has everything it names, and asks nothing of a source', () => {
    expect(availabilityOf(definitionRow(), sourceOf())).toEqual({ status: 'available' });
  });

  it('names a relationship type the mapping lost, with the path of the step', () => {
    const answer = availabilityOf(definitionRow(), sourceOf({ relationships: without('USES_TOOL').filter((row) => row.type !== 'STOCKED_AT'), derived: [], patterns: [] }));
    expect(answer).toEqual({ status: 'unavailable', reasons: [{ code: 'unknown-relationship-type', path: ['steps', 0, 'relationshipTypes', 0] }] });
  });

  it('names an entity type the mapping lost', () => {
    const answer = availabilityOf(definitionRow(), sourceOf({ entities: PATTERN_ENTITIES.filter((entity) => entity.type !== 'tool' && entity.type !== 'shop'), relationships: PATTERN_RELATIONSHIPS.filter((row) => ['LINKS', 'TRUSTS', 'ALLIES'].includes(row.type)), derived: [], patterns: [] }));
    expect(codesOf(answer)).toContain('unknown-entity-type');
    expect(answer).toMatchObject({ status: 'unavailable' });
  });

  it('names a step whose relationship type no longer joins the two entity types in its direction', () => {
    const reversed = PATTERN_RELATIONSHIPS.map((row) => (row.type === 'USES_TOOL' ? { ...row, from: 'tool', to: 'maker' } : row));
    expect(codesOf(availabilityOf(definitionRow(), sourceOf({ relationships: reversed })))).toEqual(['relationship-does-not-join']);
  });

  it('names a property the mapping no longer names and one that is no longer declared filterable', () => {
    const gone = PATTERN_ENTITIES.map((entity) => (entity.type === 'tool' ? { ...entity, filterable: [] as string[] } : entity));
    expect(codesOf(availabilityOf(definitionRow(), sourceOf({ entities: gone })))).toEqual(['unknown-property']);
    const named = PATTERN_ENTITIES.map((entity) => (entity.type === 'tool' ? { ...entity, filterable: [] as string[], search: ['kind'] } : entity));
    expect(codesOf(availabilityOf(definitionRow(), sourceOf({ entities: named })))).toEqual(['not-filterable']);
  });

  it('says a stored definition that no longer passes the schema is a bad definition, with the paths of the problems', () => {
    const old = definitionRow({ definition: { anchorType: 'maker', steps: [{ relationshipTypes: ['USES_TOOL'], direction: 'out', arrivesAt: 'tool', retired: true }] } });
    expect(availabilityOf(old, sourceOf())).toEqual({ status: 'unavailable', reasons: [{ code: 'bad-definition', path: ['steps', 0] }] });
  });

  it('does not count more steps than the source allows or a personal-data condition as a reason: the run answers those', () => {
    const lowered = sourceOf({ budgets: { max_hops: 1 } });
    const two = { anchorType: 'maker', steps: [SAVED_DEFINITION.steps[0], { relationshipTypes: ['STOCKED_AT'], direction: 'out', arrivesAt: 'shop' }] };
    expect(availabilityOf(definitionRow({ definition: two }), lowered)).toEqual({ status: 'available' });
    const personal = PATTERN_ENTITIES.map((entity) => (entity.type === 'tool' ? { ...entity, pii: [{ property: 'kind', class: 'text' }] } : entity));
    expect(availabilityOf(definitionRow(), sourceOf({ entities: personal }))).toEqual({ status: 'available' });
  });

  it('lists only the mapping problem when a definition has one and also too many steps', () => {
    const lowered = sourceOf({ budgets: { max_hops: 1 }, relationships: PATTERN_RELATIONSHIPS.filter((row) => row.type !== 'STOCKED_AT') });
    const two = { anchorType: 'maker', steps: [SAVED_DEFINITION.steps[0], { relationshipTypes: ['STOCKED_AT'], direction: 'out', arrivesAt: 'shop' }] };
    expect(codesOf(availabilityOf(definitionRow({ definition: two }), lowered))).toEqual(['unknown-relationship-type']);
  });

  it('puts no name or value of the definition in a reason, and gives the same answer every time', () => {
    const sentinel = 'zz-sentinel-name';
    const odd = definitionRow({ definition: { anchorType: sentinel, steps: [{ relationshipTypes: [sentinel], direction: 'out', arrivesAt: sentinel, conditions: [{ on: 'neighbor', property: sentinel, op: 'eq', value: { kind: 'text', value: sentinel } }] }] } });
    const first = availabilityOf(odd, sourceOf());
    expect(JSON.stringify(first)).not.toContain(sentinel);
    expect(availabilityOf(odd, sourceOf())).toEqual(first);
  });

  it('says a held starting entity of a type the definition does not start at is a changed anchor, and a row with none never is', () => {
    expect(codesOf(availabilityOf(definitionRow({ anchorEntityType: 'tool', anchorStableId: 'T-1', askForStartingEntity: false }), sourceOf()))).toEqual(['anchor-changed']);
    expect(availabilityOf(definitionRow({ anchorEntityType: 'maker', anchorStableId: 'W-1', askForStartingEntity: false }), sourceOf())).toEqual({ status: 'available' });
  });
});

describe('the availability of a saved run of a preset', () => {
  it('is available while the preset exists, names the same template and the parameters still pass, whatever version is stored', () => {
    expect(availabilityOf(presetRow(), sourceOf())).toEqual({ status: 'available' });
    expect(availabilityOf(presetRow({ templateVersion: 7, params: { maxHops: 2, direction: 'out' } }), sourceOf())).toEqual({ status: 'available' });
  });

  it('says a preset the mapping no longer has, and a row with no preset, are removed', () => {
    expect(availabilityOf(presetRow(), sourceOf({ patterns: [SHARED_PRESET] }))).toEqual({ status: 'unavailable', reasons: [{ code: 'preset-removed' }] });
    expect(codesOf(availabilityOf(presetRow({ presetId: null }), sourceOf()))).toEqual(['preset-removed']);
  });

  it('says a preset that now names another template is a changed template', () => {
    const other = { ...LINKED_PRESET, template: 'shared-attribute', bind: { anchor: 'maker', attribute: 'tool', via: 'USES_TOOL' } };
    expect(codesOf(availabilityOf(presetRow(), sourceOf({ patterns: [other] })))).toEqual(['template-changed']);
  });

  it('says parameters that no longer pass the template are invalid', () => {
    expect(codesOf(availabilityOf(presetRow({ params: { maxHops: 99 } }), sourceOf()))).toEqual(['params-invalid']);
  });

  it('says a held entity whose type is no longer the preset’s start is a changed anchor', () => {
    const moved = { ...LINKED_PRESET, bind: { anchor: 'maker', target: 'maker', via: 'LINKS' } };
    expect(codesOf(availabilityOf(presetRow({ anchorEntityType: 'tool', anchorStableId: 'T-1', askForStartingEntity: false }), sourceOf({ patterns: [moved] })))).toEqual(['anchor-changed']);
  });

  it('lists each reason once, in a fixed order', () => {
    const answer = availabilityOf(presetRow({ params: { maxHops: 99 }, anchorEntityType: 'tool', anchorStableId: 'T-1', askForStartingEntity: false }), sourceOf());
    expect(codesOf(answer)).toEqual(['params-invalid', 'anchor-changed']);
  });
});
