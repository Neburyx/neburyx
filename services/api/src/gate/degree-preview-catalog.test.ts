import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { CatalogError, createTemplateCatalog, type TemplateDefinition } from './catalog.js';
import { renderTemplate } from './render.js';
import { degreePreviewBoundedTemplate, degreePreviewCheapTemplate } from './templates/degree-preview.js';
import type { SourceAllowlist } from './types.js';

const allowlist = (type: string, label = 'Widget'): SourceAllowlist => ({
  entityLabels: new Map([['widget', label]]),
  relationshipTypes: new Set([type]),
  stableIds: new Map([['widget', 'widgetId']]),
  searchProperties: new Map(),
  referenceProperties: new Map(),
  evidenceRows: [],
  relationshipRows: [{ type, from: 'widget', to: 'widget' }],
  properties: new Set(),
});

const declared = (overrides: Partial<TemplateDefinition>): TemplateDefinition => ({ ...degreePreviewBoundedTemplate, id: 'degree-variant', ...overrides });
const catalogOf = (definition: TemplateDefinition) => () => createTemplateCatalog({ templates: [definition] });

describe('the declaration of a degree template', () => {
  it('is accepted as the bounded template declares it', () => {
    expect(() => createTemplateCatalog({ templates: [degreePreviewBoundedTemplate, degreePreviewCheapTemplate] })).not.toThrow();
  });

  it.each([
    ['a degree marker with no declaration', declared({ degreeCounts: undefined })],
    ['a declaration with Cypher that is more than its one marker', declared({ cypher: '@degreeCounts(entityType) RETURN 1' })],
    ['a declaration for a parameter that is not an entity parameter', declared({ entityParams: [] })],
    ['a paged degree template', declared({ paged: true })],
    ['a degree template with no index need', declared({ indexNeeds: undefined })],
    ['a degree template with no rule for reading nothing', declared({ readsNothing: undefined })],
    ['a cap in its own parameter schema', declared({ paramsSchema: z.strictObject({ entityType: z.string(), stableId: z.string(), countCap: z.number().int() }) })],
  ])('is refused for %s', (_name, definition) => {
    expect(catalogOf(definition)).toThrow(CatalogError);
  });
});

describe('a degree statement for a forged allowlist', () => {
  const render = (list: SourceAllowlist) => renderTemplate(createTemplateCatalog({ templates: [degreePreviewBoundedTemplate] }).find(degreePreviewBoundedTemplate.id) ?? (() => { throw new Error('missing'); })(), { entityType: 'widget', stableId: 'W-1', stableInteger: null }, list, 1, 500);

  it('quotes every name it writes', () => {
    expect(render(allowlist('LINKS')).cypher).toContain('(n)-[:`LINKS`]->()');
  });

  it('writes a count expression with quoted names for the cheap form', () => {
    const cheap = createTemplateCatalog({ templates: [degreePreviewCheapTemplate] }).find(degreePreviewCheapTemplate.id);
    if (cheap === undefined) throw new Error('missing');
    expect(renderTemplate(cheap, { entityType: 'widget', stableId: 'W-1', stableInteger: null }, allowlist('LINKS'), 1).cypher).toContain('COUNT { (n)-[:`LINKS`]->() } AS c0');
  });

  it.each([
    ['a relationship type with a backtick', allowlist('LINKS` OR 1=1 //')],
    ['a label with a backtick', allowlist('LINKS', 'Widget`')],
    ['a relationship type that is empty', allowlist('  ')],
  ])('refuses %s', (_name, list) => {
    expect(() => render(list)).toThrow(AppError);
  });
});
