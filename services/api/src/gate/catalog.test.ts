import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CatalogError, createTemplateCatalog, type TemplateDefinition } from './catalog.js';
import { connectivityTemplate } from './templates/connectivity.js';
import { edgeLoadTemplate } from './templates/edge-load.js';
import { defaultCatalogTemplates } from './assemble.js';
import { integerTemplate, markerTemplate, nodesTemplate } from '../testing/gate-fixtures.js';

function failure(...templates: TemplateDefinition[]): string {
  try {
    createTemplateCatalog({ templates });
  } catch (error) {
    if (error instanceof CatalogError) return error.message;
    throw error;
  }
  throw new Error('expected the catalog to be refused');
}

function variant(overrides: Partial<TemplateDefinition>): TemplateDefinition {
  return { ...nodesTemplate, ...overrides };
}

describe('creating a catalog', () => {
  it('holds the templates it is given, finds them by id, and enables every template for every source by default', () => {
    const catalog = createTemplateCatalog({ templates: [connectivityTemplate, nodesTemplate] });
    expect(catalog.find('connectivity')?.scope).toBe('system');
    expect(catalog.find('nodes-read')?.paged).toBe(true);
    expect(catalog.find('absent')).toBeUndefined();
    expect(catalog.isEnabled('nodes-read', 'any-source')).toBe(true);
  });

  it('uses the function that says whether a template is enabled for a source', () => {
    const catalog = createTemplateCatalog({ templates: [nodesTemplate], isEnabled: (templateId, sourceId) => !(templateId === 'nodes-read' && sourceId === 'off') });
    expect(catalog.isEnabled('nodes-read', 'off')).toBe(false);
    expect(catalog.isEnabled('nodes-read', 'on')).toBe(true);
  });

  it('records the parameters a schema declares as integers', () => {
    expect(createTemplateCatalog({ templates: [integerTemplate] }).find('integer-read')?.integerParameters).toEqual(['k']);
    expect(createTemplateCatalog({ templates: [nodesTemplate] }).find('nodes-read')?.integerParameters).toEqual([]);
  });
});

describe('a template the catalog refuses, naming the template and the problem', () => {
  it('has an id another template already uses', () => {
    expect(failure(nodesTemplate, nodesTemplate)).toBe('the template nodes-read has an id that another template already uses');
  });

  const NOT_STRICT: readonly (readonly [string, TemplateDefinition['paramsSchema']])[] = [
    ['a loose object', z.object({ kind: z.unknown() })],
    ['a record', z.record(z.string(), z.unknown())],
    ['a string', z.string().transform(() => ({}))],
  ];
  it.each(NOT_STRICT)('has a parameter schema that is %s, not a strict object', (_name, schema) => {
    expect(failure(variant({ paramsSchema: schema }))).toBe('the template nodes-read has a parameter schema that is not a strict object');
  });

  it('declares the reserved parameter limit', () => {
    expect(failure(variant({ paramsSchema: z.strictObject({ kind: z.unknown(), limit: z.number() }) }))).toBe('the template nodes-read declares the reserved parameter limit');
  });

  it('declares the reserved parameter branchEntityTypes, which the gate fills for search branches', () => {
    expect(failure(variant({ paramsSchema: z.strictObject({ kind: z.unknown(), branchEntityTypes: z.array(z.string()) }) }))).toBe('the template nodes-read declares the reserved parameter branchEntityTypes');
  });

  it('reads the branch entity types in its own Cypher, outside the placeholder the gate writes', () => {
    expect(failure(variant({ cypher: 'MATCH (n:@entity(kind)) RETURN n.id AS id, $branchEntityTypes[0] AS entityType LIMIT $limit + 1' }))).toBe('the template nodes-read reads the gate-filled parameter branchEntityTypes itself');
  });

  it.each(['MATCH (n:@entity(kind)) RETURN n.id AS id LIMIT $limit', 'MATCH (n:@entity(kind)) RETURN n.id AS id LIMIT 10', 'MATCH (n:@entity(kind)) RETURN n.id AS id LIMIT $limits + 1'])(
    'is paged and its Cypher has no LIMIT $limit + 1: %s',
    (cypher) => {
      expect(failure(variant({ cypher }))).toBe('the template nodes-read is paged and its Cypher has no LIMIT $limit + 1');
    },
  );

  it('has a marker it does not declare', () => {
    expect(failure(variant({ entityParams: [] }))).toBe('the template nodes-read has an entity marker it does not declare');
  });

  it('declares a marker its Cypher never uses', () => {
    expect(failure(variant({ relationshipParams: ['via'], paramsSchema: z.strictObject({ kind: z.unknown(), via: z.unknown() }) }))).toBe('the template nodes-read declares a relationship marker its Cypher never uses');
  });

  it('declares a marker parameter its schema does not have', () => {
    expect(failure(variant({ paramsSchema: z.strictObject({ other: z.unknown() }) }))).toBe('the template nodes-read declares a marker parameter its schema does not have');
  });

  it('has an @ in its Cypher that is not a marker', () => {
    expect(failure(variant({ cypher: 'MATCH (n:@entity(kind)) WHERE n.x = @bad RETURN n.id AS id LIMIT $limit + 1' }))).toBe('the template nodes-read has Cypher with an @ that is not a marker');
  });

  it('accepts a template whose markers and schema agree', () => {
    expect(() => createTemplateCatalog({ templates: [markerTemplate] })).not.toThrow();
  });
});

describe('gate-filled parameters', () => {
  const filled = variant({ id: 'filled', cypher: 'RETURN [x IN $mappedLabels WHERE true] AS labels', paramsSchema: z.strictObject({}), entityParams: [], paged: false, rows: 'one', gateParameters: ['mappedLabels'] });

  it('are accepted when the Cypher uses each one and the parameter schema has none of them', () => {
    expect(createTemplateCatalog({ templates: [filled] }).find('filled')?.gateParameters).toEqual(['mappedLabels']);
  });

  it('are refused when the Cypher never uses a declared one', () => {
    expect(failure({ ...filled, cypher: 'RETURN 1 AS one' })).toBe('the template filled declares the gate-filled parameter mappedLabels its Cypher never uses');
  });

  it('are refused when the Cypher uses one that is not declared', () => {
    expect(failure({ ...filled, gateParameters: [] })).toBe('the template filled uses the gate-filled parameter mappedLabels without declaring it');
  });

  it('are refused when a caller could also give one', () => {
    expect(failure({ ...filled, paramsSchema: z.strictObject({ mappedLabels: z.array(z.string()) }) })).toBe('the template filled has the gate-filled parameter mappedLabels in its parameter schema');
  });

  it('are not mistaken for a longer name: $mappedLabelsX is not $mappedLabels', () => {
    expect(failure({ ...filled, cypher: 'RETURN $mappedLabelsX AS labels' })).toBe('the template filled declares the gate-filled parameter mappedLabels its Cypher never uses');
  });
});

describe('the stable id marker', () => {
  it('is accepted when a declared entity parameter backs it', () => {
    const template = variant({ id: 'stable', cypher: 'MATCH (n:@entity(kind)) WHERE n.@stableId(kind) IS NOT NULL RETURN count(n) AS c', paged: false, rows: 'one' });
    expect(createTemplateCatalog({ templates: [template] }).find('stable')?.entityParams).toEqual(['kind']);
  });

  it('is refused when no declared entity parameter backs it', () => {
    expect(failure(variant({ id: 'stable', cypher: 'MATCH (n:@entity(kind)) WHERE n.@stableId(other) IS NOT NULL RETURN count(n) AS c', paged: false, rows: 'one' }))).toBe(
      'the template stable has a stable id marker that no declared entity parameter backs',
    );
  });
});

describe('profiled templates', () => {
  const profiled = { cypher: 'PROFILE MATCH (n:@entity(kind)) RETURN n.id AS id LIMIT 1', paged: false, rows: 'one', scope: 'system', profile: true } as const;

  it('are accepted when the flag, the PROFILE prefix and the system scope agree', () => {
    expect(createTemplateCatalog({ templates: [variant(profiled)] }).find('nodes-read')?.profile).toBe(true);
  });

  it('are refused when the flag is set and the Cypher does not start with PROFILE', () => {
    expect(failure(variant({ ...profiled, cypher: 'MATCH (n:@entity(kind)) RETURN n.id AS id LIMIT 1' }))).toBe('the template nodes-read is profiled and its Cypher does not start with PROFILE');
  });

  it('are refused when the Cypher starts with PROFILE and the flag is not set', () => {
    expect(failure(variant({ ...profiled, profile: undefined }))).toBe('the template nodes-read has Cypher that starts with PROFILE and is not declared profiled');
  });

  it('are refused for a user-scope template', () => {
    expect(failure(variant({ ...profiled, scope: 'user' }))).toBe('the template nodes-read is profiled and not a system template');
  });
});

describe('what a template that is not paged returns', () => {
  const single = variant({ id: 'single', cypher: 'MATCH (n:@entity(kind)) RETURN count(n) AS c', paged: false });

  it("is refused when it declares none of rows: 'one', cutMeans: 'duplicate' and cutMeans: 'lowerBound', as for a read of two rows with no declaration", () => {
    expect(failure(single)).toBe("the template single is not paged and does not declare exactly one of rows: 'one', rows: 'bounded', cutMeans: 'duplicate' or cutMeans: 'lowerBound'");
  });

  it('is refused when it declares both rows and cutMeans', () => {
    expect(failure({ ...single, rows: 'one', cutMeans: 'duplicate' })).toBe("the template single is not paged and does not declare exactly one of rows: 'one', rows: 'bounded', cutMeans: 'duplicate' or cutMeans: 'lowerBound'");
    expect(failure({ ...single, rows: 'one', cutMeans: 'lowerBound' })).toBe("the template single is not paged and does not declare exactly one of rows: 'one', rows: 'bounded', cutMeans: 'duplicate' or cutMeans: 'lowerBound'");
  });

  it('is accepted with one of them', () => {
    expect(createTemplateCatalog({ templates: [{ ...single, rows: 'one' }] }).find('single')?.rows).toBe('one');
    expect(createTemplateCatalog({ templates: [{ ...single, cutMeans: 'duplicate' }] }).find('single')?.cutMeans).toBe('duplicate');
    expect(createTemplateCatalog({ templates: [{ ...single, cutMeans: 'lowerBound' }] }).find('single')?.cutMeans).toBe('lowerBound');
  });

  it('is refused on a paged template, which says where its next page starts instead, so a cut that means a lower bound is accepted only for a template that is not paged', () => {
    expect(failure(variant({ rows: 'one' }))).toBe('the template nodes-read is paged and declares rows or cutMeans');
    expect(failure(variant({ cutMeans: 'duplicate' }))).toBe('the template nodes-read is paged and declares rows or cutMeans');
    expect(failure(variant({ cutMeans: 'lowerBound' }))).toBe('the template nodes-read is paged and declares rows or cutMeans');
  });
});

describe('the templates of the shipped catalog', () => {
  const templates = defaultCatalogTemplates();

  it('page every read that returns a list but the capped type-ahead prefix read, and declare every other one as one aggregate row, as bounded by its input, as the reads whose extra row means a duplicate, or as the capped read', () => {
    const cutOf = (cut: string | undefined): string => (cut === 'duplicate' ? 'cut means a duplicate' : cut === 'lowerBound' ? 'cut means a lower bound' : 'undeclared');
    const declared = Object.fromEntries(templates.map((template) => [template.id, template.paged ? 'paged' : template.rows === 'one' ? 'one row' : template.rows === 'bounded' ? 'bounded by its input' : cutOf(template.cutMeans)]));
    expect(declared).toEqual({
      connectivity: 'one row',
      capabilities: 'one row',
      privileges: 'paged',
      'schema-tokens': 'one row',
      'schema-indexes': 'one row',
      'stable-id-duplicates': 'one row',
      'degree-probe': 'one row',
      'degree-preview-bounded': 'cut means a duplicate',
      'degree-preview-cheap': 'cut means a duplicate',
      'entity-load': 'cut means a duplicate',
      'edge-load': 'cut means a duplicate',
      'expand-neighbors': 'paged',
      'expand-count': 'one row',
      'entity-search': 'paged',
      'entity-related': 'paged',
      'relationship-evidence': 'paged',
      'search-facets': 'one row',
      'entity-search-prefix': 'cut means a lower bound',
      'entity-related-context': 'bounded by its input',
      'derived-rule-run': 'cut means a lower bound',
      'derived-edge-support': 'cut means a lower bound',
      'aggregate-sample': 'one row',
      'aggregate-summary': 'one row',
    });
  });

  it('are accepted by the catalog', () => {
    expect(() => createTemplateCatalog({ templates })).not.toThrow();
  });
});

describe('the edge load declaration', () => {
  const failure = (definition: Partial<TemplateDefinition>): string | undefined => {
    try {
      createTemplateCatalog({ templates: [{ ...edgeLoadTemplate, ...definition }] });
      return undefined;
    } catch (error) {
      return error instanceof CatalogError ? error.message : 'not a CatalogError';
    }
  };

  it('is accepted as shipped', () => {
    expect(failure({})).toBeUndefined();
  });

  it('is refused when the Cypher is more than its one marker', () => {
    expect(failure({ cypher: '@edgeLoad(type) LIMIT 5' })).toBe('the template edge-load declares an edge load and its Cypher is not exactly its one edge load marker');
  });

  it('is refused when the marker is used without the declaration', () => {
    expect(failure({ edgeLoad: undefined })).toBe('the template edge-load uses the edge load marker without declaring an edge load');
  });

  it('is refused when it is paged, or says a cut means something else than a duplicate', () => {
    expect(failure({ paged: true })).toBe('the template edge-load is paged and declares rows or cutMeans');
    expect(failure({ cutMeans: 'lowerBound' })).toContain('declares an edge load and is also another kind of template');
  });

  it('is refused when it does not name its index and its properties', () => {
    expect(failure({ indexNeeds: undefined })).toBe('the template edge-load declares an edge load and does not name its index and its properties');
  });

  it('is refused when its schema lacks a parameter it names', () => {
    expect(failure({ edgeLoad: { typeParam: 'type', fromParam: 'from', toParam: 'missing' } })).toBe('the template edge-load declares an edge load for parameters its schema does not have');
  });
});
