import { describe, expect, it } from 'vitest';
import { generateFixture } from './fixture/generate.js';
import { formatCount, initialPositions, nodeLabel, relationshipLabel } from './look.js';

describe('formatCount', () => {
  it('shows each quality the way the UI copy does and no number when unknown', () => {
    expect(formatCount({ value: 3000, quality: 'exact', scope: 's' })).toBe('3,000');
    expect(formatCount({ value: 3000, quality: 'estimated', scope: 's' })).toBe('~ 3,000');
    expect(formatCount({ value: 3000, quality: 'lowerBound', scope: 's' })).toBe('≥ 3,000');
    expect(formatCount({ quality: 'unknown', scope: 's' })).toBe('');
  });
});

describe('labels', () => {
  const fixture = generateFixture({ seed: 1 });

  it('labels the neighbor aggregate node with loaded over a lower-bound total', () => {
    const aggregate = fixture.nodes.find((node) => node.kind === 'neighborAggregate');
    expect(aggregate && nodeLabel(fixture, aggregate)).toMatch(/^Type [A-D] · \d+ \/ ≥ 3,000$/);
  });

  it('labels an entity node with its reference and a second line of type and state', () => {
    const entity = fixture.nodes.find((node) => node.kind === 'entity');
    expect(entity && nodeLabel(fixture, entity)).toMatch(/^[A-D]-\d{4}\nType [A-D] · (open|review|closed)$/);
  });

  it('labels the aggregate relationship with its type and exact member count and the others with their type', () => {
    const aggregate = fixture.relationships.find((relationship) => relationship.kind === 'aggregate');
    expect(aggregate && relationshipLabel(aggregate)).toMatch(/^rel-b · \d+$/);
    const derived = fixture.relationships.find((relationship) => relationship.kind === 'derived');
    expect(derived && relationshipLabel(derived)).toMatch(/ · derived$/);
  });
});

describe('initialPositions', () => {
  it('gives every node a position and the same positions for the same fixture', () => {
    const fixture = generateFixture({ seed: 4 });
    const first = initialPositions(fixture);
    expect(first.size).toBe(fixture.nodes.length);
    expect([...initialPositions(fixture)]).toEqual([...first]);
  });
});
