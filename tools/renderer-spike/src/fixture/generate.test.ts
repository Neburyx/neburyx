import { describe, expect, it } from 'vitest';
import { FixtureError } from './errors.js';
import { DEFAULT_ELEMENTS, MAX_ELEMENTS, MIN_ELEMENTS, NEIGHBOR_AGGREGATE_TOTAL, generateFixture, parseFixture } from './generate.js';
import { elementCount } from './schema.js';

describe('generateFixture', () => {
  it('gives the same fixture for the same seed and another for a different seed', () => {
    expect(generateFixture({ seed: 7 })).toEqual(generateFixture({ seed: 7 }));
    expect(generateFixture({ seed: 8 })).not.toEqual(generateFixture({ seed: 7 }));
  });

  it('holds exactly 300 drawn elements by default', () => {
    expect(elementCount(generateFixture({ seed: 1 }))).toBe(DEFAULT_ELEMENTS);
  });

  it('has at least three entity types, each with a display name and an icon key', () => {
    const fixture = generateFixture({ seed: 1 });
    expect(fixture.types.length).toBeGreaterThanOrEqual(3);
    for (const type of fixture.types) {
      expect(type.displayName.length).toBeGreaterThan(0);
      expect(type.iconKey.length).toBeGreaterThan(0);
    }
  });

  it('has sourced, derived and exactly one aggregate relationship with an exact member count', () => {
    const fixture = generateFixture({ seed: 1 });
    const kinds = new Set(fixture.relationships.map((relationship) => relationship.kind));
    expect(kinds).toEqual(new Set(['sourced', 'derived', 'aggregate']));
    const aggregates = fixture.relationships.filter((relationship) => relationship.kind === 'aggregate');
    expect(aggregates).toHaveLength(1);
    const [aggregate] = aggregates;
    expect(aggregate?.kind === 'aggregate' ? aggregate.members.quality : undefined).toBe('exact');
  });

  it('has one neighbor aggregate node of 3,000 with quality lowerBound and no node for those neighbors', () => {
    const fixture = generateFixture({ seed: 1 });
    const aggregates = fixture.nodes.filter((node) => node.kind === 'neighborAggregate');
    expect(aggregates).toHaveLength(1);
    const [aggregate] = aggregates;
    expect(aggregate?.kind === 'neighborAggregate' ? aggregate.total : undefined).toMatchObject({ value: NEIGHBOR_AGGREGATE_TOTAL, quality: 'lowerBound' });
    expect(fixture.nodes.length).toBeLessThan(NEIGHBOR_AGGREGATE_TOTAL / 10);
  });

  it('counts as loaded the neighbors of the supernode that are drawn, of the aggregate node\'s type', () => {
    const fixture = generateFixture({ seed: 1 });
    const aggregate = fixture.nodes.find((node) => node.kind === 'neighborAggregate');
    const hub = fixture.nodes[0];
    const drawnNeighbors = fixture.relationships
      .filter((relationship) => relationship.from === hub?.id)
      .map((relationship) => fixture.nodes.find((node) => node.id === relationship.to))
      .filter((node) => node?.kind === 'entity' && node.type === aggregate?.type);
    expect(aggregate?.kind === 'neighborAggregate' ? aggregate.loaded : -1).toBe(drawnNeighbors.length);
    expect(drawnNeighbors.length).toBeGreaterThan(0);
  });

  it('uses only neutral names', () => {
    const fixture = generateFixture({ seed: 3 });
    const names = [
      ...fixture.types.flatMap((type) => [type.id, type.displayName]),
      ...fixture.nodes.map((node) => (node.kind === 'entity' ? node.label : node.type)),
      ...fixture.relationships.map((relationship) => relationship.type),
    ];
    for (const name of names) expect(name).toMatch(/^(type-[a-d]|Type [A-D]|[A-D]-\d{4}|rel-[a-c])$/);
  });

  it('keeps every relationship pointing at a node of the fixture', () => {
    const fixture = generateFixture({ seed: 5 });
    const ids = new Set(fixture.nodes.map((node) => node.id));
    for (const relationship of fixture.relationships) {
      expect(ids.has(relationship.from)).toBe(true);
      expect(ids.has(relationship.to)).toBe(true);
    }
  });

  it.each([
    ['an element count below the minimum', { seed: 1, elements: MIN_ELEMENTS - 1 }, 'elements'],
    ['an element count above the maximum', { seed: 1, elements: MAX_ELEMENTS + 1 }, 'elements'],
    ['a negative element count', { seed: 1, elements: -5 }, 'elements'],
    ['a fractional element count', { seed: 1, elements: 300.5 }, 'elements'],
    ['a fractional seed', { seed: 1.5 }, 'seed'],
    ['a negative seed', { seed: -1 }, 'seed'],
  ])('refuses %s with a named error that does not repeat the input', (_name, input, parameter) => {
    let caught: unknown;
    try {
      generateFixture(input);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FixtureError);
    expect(caught).toMatchObject({ code: 'FIXTURE_PARAMETER_INVALID', parameter });
    expect(caught instanceof Error ? caught.message : '').not.toMatch(/\d/);
  });
});

describe('parseFixture', () => {
  it('refuses a relationship whose id is the id of a node, which a renderer would silently drop', () => {
    const fixture = generateFixture({ seed: 2 });
    const [first, ...rest] = fixture.relationships;
    const clash = { ...fixture, relationships: first === undefined ? [] : [{ ...first, id: fixture.nodes[0]?.id ?? 'n-0000' }, ...rest] };
    expect(() => parseFixture(clash)).toThrowError(expect.objectContaining({ code: 'FIXTURE_INVALID' }));
  });

  it('accepts a generated fixture', () => {
    const fixture = generateFixture({ seed: 2 });
    expect(parseFixture(fixture)).toEqual(fixture);
  });

  it('refuses a relationship that names an unknown node, without repeating the value', () => {
    const fixture = generateFixture({ seed: 2 });
    const broken = { ...fixture, relationships: [{ kind: 'sourced', id: 'r-x', type: 'rel-a', from: 'secret-node', to: 'n-0000' }] };
    expect(() => parseFixture(broken)).toThrowError(expect.objectContaining({ code: 'FIXTURE_INVALID' }));
    expect(() => parseFixture(broken)).not.toThrowError(/secret-node/);
  });
});
