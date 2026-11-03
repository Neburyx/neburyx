import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CatalogError, createTemplateCatalog, type TemplateDefinition } from './catalog.js';
import { connectivityTemplate } from './templates/connectivity.js';
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
  const filled = variant({ id: 'filled', cypher: 'RETURN [x IN $mappedLabels WHERE true] AS labels', paramsSchema: z.strictObject({}), entityParams: [], paged: false, gateParameters: ['mappedLabels'] });

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
    const template = variant({ id: 'stable', cypher: 'MATCH (n:@entity(kind)) WHERE n.@stableId(kind) IS NOT NULL RETURN count(n) AS c', paged: false });
    expect(createTemplateCatalog({ templates: [template] }).find('stable')?.entityParams).toEqual(['kind']);
  });

  it('is refused when no declared entity parameter backs it', () => {
    expect(failure(variant({ id: 'stable', cypher: 'MATCH (n:@entity(kind)) WHERE n.@stableId(other) IS NOT NULL RETURN count(n) AS c', paged: false }))).toBe(
      'the template stable has a stable id marker that no declared entity parameter backs',
    );
  });
});

describe('profiled templates', () => {
  const profiled = { cypher: 'PROFILE MATCH (n:@entity(kind)) RETURN n.id AS id LIMIT 1', paged: false, scope: 'system', profile: true } as const;

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
