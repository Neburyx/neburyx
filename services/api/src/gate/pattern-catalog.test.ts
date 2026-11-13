import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CatalogError, createTemplateCatalog, type TemplateDefinition } from './catalog.js';
import { defaultCatalogTemplates } from './assemble.js';
import { linkedEntitiesTemplate } from './templates/linked-entities.js';
import { PATTERN_ID, patternTemplate } from './templates/pattern.js';

const problem = (overrides: Partial<TemplateDefinition>): string | undefined => {
  try {
    createTemplateCatalog({ templates: [{ ...patternTemplate, ...overrides }] });
    return undefined;
  } catch (error) {
    return error instanceof CatalogError ? error.message : 'not a CatalogError';
  }
};
const schemaWith = (shape: Record<string, z.ZodType>) => z.strictObject({ anchorType: z.string(), stableId: z.string(), steps: z.array(z.unknown()), ...shape });

describe('the catalog entry of the pattern template', () => {
  it('is in the default catalog, and is a version 2 read paged by the end entity whose steps are its hop list', () => {
    expect(defaultCatalogTemplates().map((template) => template.id)).toContain(PATTERN_ID);
    expect(patternTemplate).toMatchObject({ id: 'pattern', version: '2', auditAction: 'pattern.run', paged: true, sort: 'end-id', referencePositions: [{ entityType: 'endType', stableId: 'endKey' }], hops: { listParam: 'steps', max: 4 } });
  });

  it('accepts the shipped declaration', () => {
    expect(problem({})).toBeUndefined();
  });

  it('refuses a statement that is not its one marker, and a marker without the declaration', () => {
    expect(problem({ cypher: 'MATCH (n) RETURN n' })).toContain('the template pattern');
    expect(problem({ pattern: undefined })).toBe('the template pattern declares an entity marker its Cypher never uses');
    expect(problem({ cypher: '@pattern(anchorType) LIMIT 1' })).toContain('is not exactly its one pattern marker');
  });

  it('refuses a declaration of parameters its schema does not have as text and as a list, or that are not declared as entity parameters', () => {
    expect(problem({ paramsSchema: schemaWith({}).extend({ steps: z.string() }) })).toContain('declares a pattern read for parameters its schema does not have as text and as a list');
    expect(problem({ entityParams: [] })).toContain('has a stable id marker that no declared entity parameter backs');
    expect(problem({ relationshipParams: ['steps'] })).toContain('declares a relationship marker its Cypher never uses');
  });

  it('takes its steps as its hop list', () => {
    expect(problem({ hops: { listParam: 'steps', max: 2 } })).toBeUndefined();
    expect(problem({ hops: { param: 'steps', max: 4 } })).toContain('does not take its steps as its hop list');
    expect(problem({ hops: undefined })).toContain('does not take its steps as its hop list');
    expect(problem({ hops: { listParam: 'other', max: 4 } })).toContain('does not take its steps as its hop list');
    expect(problem({ hops: { listParam: 'steps', max: 5 } })).toContain('declares a hop maximum outside 1 to 4');
  });

  it('checks a hop list in the catalog for any template: a parameter that is a list passes, one that is not a list fails', () => {
    const other = (hops: TemplateDefinition['hops']): string | undefined => {
      try {
        createTemplateCatalog({ templates: [{ ...linkedEntitiesTemplate, hops }] });
        return undefined;
      } catch (error) {
        return error instanceof CatalogError ? error.message : 'not a CatalogError';
      }
    };
    expect(other({ listParam: 'via', max: 2 })).toBeUndefined();
    expect(other({ listParam: 'entityType', max: 2 })).toBe('the template linked-entities declares a hop list its schema does not have as a list');
    expect(other({ listParam: 'missing', max: 2 })).toBe('the template linked-entities declares a hop list its schema does not have as a list');
  });

  it('refuses a schema that holds a limit or a count cap, a profiled template and a run that is not paged by the end entity with its positions', () => {
    expect(problem({ paramsSchema: schemaWith({ limit: z.number() }) })).toBe('the template pattern declares the reserved parameter limit');
    expect(problem({ paramsSchema: schemaWith({ countCap: z.number() }) })).toContain('has a limit or a count cap in its schema');
    expect(problem({ paged: false })).toContain('is not paged and does not declare');
    expect(problem({ sort: 'elementId' })).toContain('is not paged by the end entity');
    expect(problem({ nextPosition: undefined })).toContain('is not paged by the end entity');
    expect(problem({ referencePositions: undefined })).toContain('is not paged by the end entity');
    expect(problem({ referencePositions: [] })).toContain('is not paged by the end entity');
    expect(problem({ profile: true })).toBe('the template pattern is profiled and its Cypher does not start with PROFILE');
    expect(problem({ searchBranches: { param: 'steps', allowlist: 'search', value: 'x', text: 'y' } })).toBe('the template pattern declares search branches and does not use its branch marker exactly once');
    expect(problem({ linkedEntities: {} as never })).toBe('the template pattern declares a linked entities read and its Cypher is not exactly its one linked entities marker');
    expect(problem({ pattern: { entityTypeParam: 'anchorType', stepsParam: 'steps', count: true } })).toBe("the template pattern declares a pattern count and is paged or not declared cutMeans: 'lowerBound'");
  });

  it('refuses a read that names no indexes, no used properties or no reference for its anchor', () => {
    expect(problem({ indexNeeds: undefined })).toContain('does not name its indexes');
    expect(problem({ usedProperties: undefined })).toContain('does not name its indexes');
    expect(problem({ referenceParams: undefined })).toContain('does not name its indexes');
  });
});
