import { patternDefinitionSchema } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { DERIVED_RULE } from '../testing/derived-fixtures.js';
import { linkedMappingOf } from '../testing/linked-entities-fixtures.js';
import { PATTERN_ENTITIES, PATTERN_RELATIONSHIPS, parsedPatternParams, patternAllowlist, patternMappingOf, patternParams, step } from '../testing/pattern-fixtures.js';
import { patternParamsSchema, patternRequestOf } from './templates/pattern-request.js';
import { patternTemplate } from './templates/pattern.js';

const allowlist = patternAllowlist();
const requestOf = (steps: Record<string, unknown>[], list = allowlist) => patternRequestOf(list, parsedPatternParams(steps));
const TOOL = step({ relationshipTypes: ['USES_TOOL'], arrivesAt: 'tool' });
const BACK = step({ relationshipTypes: ['USES_TOOL'], direction: 'in', arrivesAt: 'maker' });
const WINDOW = { windowFrom: '2026-01-01T00:00:00Z', windowTo: '2026-02-01T00:00:00Z' };

describe('the parameters of a pattern run', () => {
  it('accept one to four steps and no more, and a step with its conditions and a window of two instants', () => {
    expect(patternParamsSchema.safeParse(patternParams([step()])).success).toBe(true);
    expect(patternParamsSchema.safeParse(patternParams(Array.from({ length: 4 }, () => step()))).success).toBe(true);
    expect(patternParamsSchema.safeParse(patternParams(Array.from({ length: 5 }, () => step()))).success).toBe(false);
    expect(patternParamsSchema.safeParse(patternParams([])).success).toBe(false);
    expect(patternParamsSchema.safeParse(patternParams([step({ ...WINDOW })])).success).toBe(true);
    expect(patternParamsSchema.safeParse(patternParams([step({ windowTo: WINDOW.windowTo })])).success).toBe(false);
  });

  it('break no cap of the definition: types per step, distinct types, conditions per element and per pattern', () => {
    const eq = { on: 'neighbor', property: 'region', op: 'eq', value: { kind: 'text', value: 'x' } };
    expect(patternParamsSchema.safeParse(patternParams([step({ relationshipTypes: ['A', 'B', 'C', 'D', 'E', 'F', 'G'] })])).success).toBe(false);
    expect(patternParamsSchema.safeParse(patternParams([step({ relationshipTypes: ['LINKS', 'LINKS'] })])).success).toBe(false);
    expect(patternParamsSchema.safeParse(patternParams([step({ conditions: Array.from({ length: 7 }, () => eq) })])).success).toBe(false);
    const seven = [...Array.from({ length: 4 }, () => eq), ...Array.from({ length: 3 }, () => ({ ...eq, on: 'relationship' }))];
    expect(patternParamsSchema.safeParse(patternParams(Array.from({ length: 4 }, () => step({ conditions: seven })))).success).toBe(false);
    expect(patternParamsSchema.safeParse(patternParams(Array.from({ length: 4 }, () => step({ conditions: seven.slice(0, 6) })))).success).toBe(true);
  });

  it('read a definition that is valid under the shared schema once its window is resolved to instants', () => {
    const definition: { anchorType: string; steps: Record<string, unknown>[] } = { anchorType: 'maker', steps: [step({ conditions: [{ on: 'neighbor', property: 'region', op: 'eq', value: { kind: 'text', value: 'x' } }], window: { days: 30 } })] };
    expect(patternDefinitionSchema.safeParse(definition).success).toBe(true);
    const resolved = { anchorType: 'maker', stableId: 'A-1', steps: definition.steps.map(({ window: _window, ...rest }) => ({ ...rest, ...WINDOW })) };
    expect(patternParamsSchema.safeParse(resolved).success).toBe(true);
  });

  it('refuse a key the schema does not name, at the top and in a step', () => {
    expect(patternParamsSchema.safeParse(patternParams([step()], { extra: 1 })).success).toBe(false);
    expect(patternParamsSchema.safeParse(patternParams([step({ extra: 1 })])).success).toBe(false);
  });
});

describe('the request of a pattern run, checked against the mapping', () => {
  it('holds, for each step, the rows it crosses, its conditions and whether it is windowed', () => {
    const request = requestOf([TOOL, BACK]);
    expect(request.anchor).toBe('maker');
    expect(request.steps.map((entry) => [entry.from, entry.arrivesAt, entry.branches.map((branch) => `${branch.type}:${branch.direction}`)])).toEqual([
      ['maker', 'tool', ['USES_TOOL:out']],
      ['tool', 'maker', ['USES_TOOL:in']],
    ]);
    expect(request.windowed).toBe(false);
  });

  it('crosses a row both ways for both, and a row that joins a type to itself in each direction', () => {
    expect(requestOf([step({ direction: 'both' })]).steps[0]?.branches.map((branch) => branch.direction)).toEqual(['out', 'in']);
  });

  it.each([
    ['an anchor the mapping does not have', parsedPatternParams([step()], { anchorType: 'nothing' })],
    ['an arrival type the mapping does not have', parsedPatternParams([step({ arrivesAt: 'nothing' })])],
    ['a relationship type the mapping does not have', parsedPatternParams([step({ relationshipTypes: ['NOPE'] })])],
    ['a type that does not join the types in the direction', parsedPatternParams([step({ relationshipTypes: ['USES_TOOL'], arrivesAt: 'tool', direction: 'in' })])],
    ['a second step that does not start from the first step’s arrival', parsedPatternParams([TOOL, step({ relationshipTypes: ['LINKS'] })])],
    ['a list where only some of the types join', parsedPatternParams([step({ relationshipTypes: ['LINKS', 'USES_TOOL'] })])],
    ['a condition on a property the mapping does not declare filterable', parsedPatternParams([step({ conditions: [{ on: 'neighbor', property: 'makerId', op: 'eq', value: { kind: 'text', value: 'x' } }] })])],
    ['a relationship condition that one of the listed types does not declare', parsedPatternParams([step({ relationshipTypes: ['LINKS', 'TRUSTS'], conditions: [{ on: 'relationship', property: 'lane', op: 'eq', value: { kind: 'text', value: 'x' } }] })])],
  ])('refuses %s with no name in the error', (_name, params) => {
    let error: unknown;
    try {
      patternRequestOf(allowlist, params);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'INVALID_REQUEST' });
    expect(JSON.stringify(error)).not.toMatch(/nothing|NOPE|makerId|LINKS/);
  });

  it('lists the relationship types of a windowed step that have a row with no time, once each across the steps', () => {
    const request = requestOf([step({ relationshipTypes: ['LINKS', 'TRUSTS'], ...WINDOW }), step({ relationshipTypes: ['TRUSTS'], ...WINDOW })]);
    expect(request.windowed).toBe(true);
    expect(request.untimedTypes).toEqual(['TRUSTS']);
    expect(requestOf([step({ relationshipTypes: ['LINKS', 'TRUSTS'] })]).untimedTypes).toEqual([]);
  });

  it('puts a type on the stop-list for the entities between steps by any rule whose middle is that type, whether or not the rule’s relationship types are in the pattern', () => {
    expect(requestOf([TOOL, BACK]).stopListed.get('tool')).toEqual(['isCommon']);
    const elsewhere = linkedMappingOf({
      entities: PATTERN_ENTITIES,
      relationships: PATTERN_RELATIONSHIPS,
      derived: [{ id: 'other', from: 'maker', to: 'maker', via: ['TRUSTS', 'maker', 'TRUSTS'], rule_version: 1, stop_list_property: 'isIgnored' }],
      patterns: [],
    });
    const request = patternRequestOf(patternAllowlist(elsewhere), parsedPatternParams([TOOL, BACK]));
    expect(request.stopListed.size).toBe(0);
    const middle = patternRequestOf(patternAllowlist(elsewhere), parsedPatternParams([step(), step()]));
    expect(middle.stopListed.get('maker')).toEqual(['isIgnored']);
  });

  it('holds no stop-list for a single step, and never for the anchor or the entities the last step reaches', () => {
    expect(requestOf([step()]).stopListed.size).toBe(0);
    expect(requestOf([TOOL]).stopListed.size).toBe(0);
  });
});

describe('the pattern template', () => {
  it('names the properties it uses: the stop-list, the conditions with their types and the observed times of windowed steps', () => {
    const params = parsedPatternParams([
      step({ relationshipTypes: ['USES_TOOL'], arrivesAt: 'tool', conditions: [{ on: 'neighbor', property: 'kind', op: 'eq', value: { kind: 'text', value: 'x' } }] }),
      step({ relationshipTypes: ['USES_TOOL'], direction: 'in', arrivesAt: 'maker' }),
      step({ conditions: [{ on: 'relationship', property: 'lane', op: 'eq', value: { kind: 'text', value: 'x' } }], ...WINDOW }),
    ]);
    expect(patternTemplate.usedProperties?.(params, allowlist)).toEqual([
      { entityType: 'tool', property: 'isCommon' },
      { entityType: 'tool', property: 'kind' },
      { relationshipType: 'LINKS', from: 'maker', to: 'maker', property: 'lane' },
      { relationshipType: 'LINKS', from: 'maker', to: 'maker', property: 'seenAt' },
    ]);
    const listed = parsedPatternParams([step({ relationshipTypes: ['LINKS', 'ALLIES'], conditions: [{ on: 'relationship', property: 'lane', op: 'eq', value: { kind: 'text', value: 'x' } }] })]);
    expect(patternTemplate.usedProperties?.(listed, allowlist)).toEqual([
      { relationshipType: 'LINKS', from: 'maker', to: 'maker', property: 'lane' },
      { relationshipType: 'ALLIES', from: 'maker', to: 'maker', property: 'lane' },
    ]);
    expect(patternTemplate.indexNeeds?.(params, allowlist)).toEqual([{ entityType: 'maker', property: 'makerId', accepts: 'value' }]);
  });

  it('is built as the template the catalog expects: its marker, its hop list, no listing', () => {
    expect(patternTemplate).toMatchObject({ id: 'pattern', version: '1', paged: false, cutMeans: 'lowerBound', cypher: '@pattern(anchorType)', hops: { listParam: 'steps', max: 4 } });
    expect(patternMappingOf().sources.length).toBe(1);
  });
});
