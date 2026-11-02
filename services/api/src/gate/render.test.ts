import { describe, expect, it } from 'vitest';
import { nameProblem, renderTemplate } from './render.js';
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
