import { describe, expect, it } from 'vitest';
import { nameProblem, renderTemplate } from './render.js';
import { SEARCH_EXACT_ID, searchExactTemplate } from './templates/search-exact.js';
import { markerTemplate, nodesTemplate } from '../testing/gate-fixtures.js';
import { createTemplateCatalog } from './catalog.js';
import type { SourceAllowlist } from './types.js';

function templateOf(id: string) {
  const template = createTemplateCatalog({ templates: [markerTemplate, nodesTemplate] }).find(id);
  if (template === undefined) throw new Error(`no template ${id}`);
  return template;
}

const ALLOWLIST: SourceAllowlist = {
  entityLabels: new Map([['person', 'Person']]),
  relationshipTypes: new Set(['KNOWS', 'HAS LINE']),
  stableIds: new Map([['person', 'id']]),
  searchProperties: new Map([['person', ['id', 'name']]]),
  referenceProperties: new Map(),
  evidenceRows: [],
  relationshipRows: [],
  properties: new Set(['id', 'name']),
};

describe('renderTemplate', () => {
  it('writes the quoted label and the limit, and keeps every other parameter a parameter', () => {
    const rendered = renderTemplate(templateOf('marker-read'), { kind: 'person', via: ['KNOWS', 'HAS LINE'], ref: undefined }, ALLOWLIST, 5);
    expect(rendered.cypher).toBe('MATCH (n:`Person`)-[r:`KNOWS`|`HAS LINE`]->(m) RETURN n.id AS id LIMIT $limit + 1');
    expect(rendered.parameters).toEqual({ ref: undefined, limit: 5 });
  });

  it('keeps a parameter named __proto__ as an own key', () => {
    const params = JSON.parse('{"kind": "person", "__proto__": {"x": 1}}');
    const { parameters } = renderTemplate(templateOf('nodes-read'), params, ALLOWLIST, 3);
    expect(Object.hasOwn(parameters, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(parameters)).toBe(Object.prototype);
  });
});

describe('nameProblem', () => {
  it.each([
    ['', 'is empty or only whitespace'],
    ['  ', 'is empty or only whitespace'],
    ['a`b', 'holds a backtick, a backslash or a control character'],
    ['a\\b', 'holds a backtick, a backslash or a control character'],
    ['a\u007fb', 'holds a backtick, a backslash or a control character'],
    ['Order Line', undefined],
  ])('for %j', (name, problem) => {
    expect(nameProblem(name)).toBe(problem);
  });
});

describe('the gate-filled parameters and the stable id marker', () => {
  const filled = createTemplateCatalog({
    templates: [
      {
        ...nodesTemplate,
        id: 'schema',
        cypher: 'MATCH (n:@entity(kind)) WHERE n.@stableId(kind) IN $mappedProperties AND size($mappedLabels + $mappedTypes) > 0 RETURN n.@stableId(kind) AS id LIMIT $limit + 1',
        gateParameters: ['mappedLabels', 'mappedTypes', 'mappedProperties'],
      },
    ],
  }).find('schema');
  if (filled === undefined) throw new Error('no template schema');

  it('writes the stable id of the entity type as a quoted name and adds the lists from the allowlist, sorted, after the limit', () => {
    const rendered = renderTemplate(filled, { kind: 'person' }, ALLOWLIST, 5);
    expect(rendered.cypher).toBe('MATCH (n:`Person`) WHERE n.`id` IN $mappedProperties AND size($mappedLabels + $mappedTypes) > 0 RETURN n.`id` AS id LIMIT $limit + 1');
    expect(rendered.parameters).toEqual({ limit: 5, mappedLabels: ['Person'], mappedTypes: ['HAS LINE', 'KNOWS'], mappedProperties: ['id', 'name'] });
  });

  it('cannot be given by a caller: a request that sets one is refused by the parameter schema, and a value in the request never reaches the parameters', () => {
    const { parameters } = renderTemplate(filled, { kind: 'person', mappedLabels: ['Injected'] }, ALLOWLIST, 5);
    expect(parameters['mappedLabels']).toEqual(['Person']);
  });

  it('refuses an entity type that is not in the allowlist', () => {
    expect(() => renderTemplate(filled, { kind: 'absent' }, ALLOWLIST, 5)).toThrow();
  });
});

describe('the entity type a search branch returns', () => {
  const ODD_TYPE = "it's \\ a\nb 😀";
  const searchExact = createTemplateCatalog({ templates: [searchExactTemplate] }).find(SEARCH_EXACT_ID);
  if (searchExact === undefined) throw new Error('no search template');
  const allowlist: SourceAllowlist = {
    ...ALLOWLIST,
    entityLabels: new Map([
      ['person', 'Person'],
      [ODD_TYPE, 'Odd'],
    ]),
    searchProperties: new Map([
      ['person', ['id', 'name']],
      [ODD_TYPE, ['code']],
    ]),
  };
  const targets = [
    { entityType: ODD_TYPE, property: 'code', match: 'value' as const },
    { entityType: 'person', property: 'name', match: 'text' as const },
  ];

  it('is a reference to the gate-filled list at the branch position, never a name in the statement text', () => {
    const rendered = renderTemplate(searchExact, { text: 'x', targets }, allowlist, 5);
    expect(rendered.cypher).toContain('RETURN n, $branchEntityTypes[0] AS entityType');
    expect(rendered.cypher).toContain('RETURN n, $branchEntityTypes[1] AS entityType');
    expect(rendered.cypher).not.toContain("it's");
    expect(rendered.cypher).not.toContain("'person'");
    expect(rendered.parameters['branchEntityTypes']).toEqual([ODD_TYPE, 'person']);
  });

  it('is filled from the validated targets only: a value of the request under that name is replaced', () => {
    const rendered = renderTemplate(searchExact, { text: 'x', targets, branchEntityTypes: ['Injected'] }, allowlist, 5);
    expect(rendered.parameters['branchEntityTypes']).toEqual([ODD_TYPE, 'person']);
  });

  it('refuses a target whose entity type is not in the allowlist, so no list is written for it', () => {
    expect(() => renderTemplate(searchExact, { text: 'x', targets: [{ entityType: 'absent', property: 'code', match: 'value' }] }, allowlist, 5)).toThrow();
  });
});
