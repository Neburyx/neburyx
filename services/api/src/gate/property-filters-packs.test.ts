import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { relationshipProjection } from '../mapping/projection.js';
import { PACKS, packSource, repoRoot } from '../testing/pack-fixtures.js';

interface DemoRelationship {
  readonly type: string;
  readonly properties?: Record<string, unknown>;
}

/** The relationship rows of a pack's demo data definition, by type, with the properties each gives a relationship. */
function demoRelationships(pack: string): DemoRelationship[] {
  const document = parse(readFileSync(join(repoRoot, 'domain-packs', pack, 'demo.yaml'), 'utf8')) as { relationships?: DemoRelationship[] };
  return document.relationships ?? [];
}

describe.each(PACKS)('the property filters of the %s pack', (pack) => {
  const source = packSource(pack);
  const stored = source.relationships.filter((row) => !row.aggregate && row.filterable.length > 0);

  it('has an entity type with a filterable property that is not personal data, for the Filters panel to offer', () => {
    const offered = source.entities.flatMap((entity) => entity.filterable.filter((property) => !entity.pii.includes(property)));
    expect(offered.length).toBeGreaterThan(0);
  });

  it('has a stored relationship row with a filterable property that the row projects, for the Filters panel to offer', () => {
    expect(stored.length).toBeGreaterThan(0);
    for (const row of stored) for (const property of row.filterable) expect(relationshipProjection(row)).toContain(property);
  });

  it('gives its demo data a value for each filterable property of a stored relationship row, so a filter has something to choose', () => {
    const demo = demoRelationships(pack);
    for (const row of stored) {
      const generated = demo.filter((candidate) => candidate.type === row.type);
      expect(generated.length).toBeGreaterThan(0);
      for (const property of row.filterable) expect(generated.some((candidate) => candidate.properties !== undefined && property in candidate.properties)).toBe(true);
    }
  });

  it('declares no kind that disagrees between the stored rows of one relationship type', () => {
    const kinds = new Map<string, Set<string>>();
    for (const row of stored) for (const [property, kind] of Object.entries(row.kinds ?? {})) kinds.set(`${row.type}\u0000${property}`, (kinds.get(`${row.type}\u0000${property}`) ?? new Set()).add(kind));
    for (const declared of kinds.values()) expect(declared.size).toBe(1);
  });
});
