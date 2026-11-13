import { rmSync } from 'node:fs';
import { PRESET_TEMPLATES, linkedEntitiesParamsSchema, paramsJsonSchemaOf, sharedAttributeParamsSchema, referenceTextSchema, templateListResponseSchema, TEMPLATE_PARAMS_SCHEMAS } from '@neburyx/contracts';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from '../app.js';
import { defaultCatalogTemplates } from '../gate/assemble.js';
import { createTemplateCatalog } from '../gate/catalog.js';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { createLogger } from '../logger.js';
import { presetProfilesOf } from '../registry/profile.js';
import { communitySeams } from '../seams/community-seams.js';
import { memoryAppStore } from '../testing/app-store.js';
import { TestExecutor } from '../testing/gate.js';
import { LINKED_PRESET, linkedMappingOf, linkedRow } from '../testing/linked-entities-fixtures.js';
import { SHARED_PRESET, sharedRow } from '../testing/shared-attribute-fixtures.js';
import { onlineIndexesOf, schemaAnswer, withSchema } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';
import type { TemplateCatalog } from '../gate/types.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const DATED = [
  { type: 'ENDORSES', from: 'shop', to: 'maker', stable_id: 'endorseId' },
  { type: 'LINKS', from: 'maker', to: 'maker', stable_id: 'linkId', observed_at: 'seenAt' },
  { type: 'USES_TOOL', from: 'maker', to: 'tool', stable_id: 'useId', observed_at: 'seenAt' },
];
const mappingOf = (patterns: readonly Record<string, unknown>[] = [LINKED_PRESET, SHARED_PRESET]) => linkedMappingOf({ relationships: DATED, patterns });

async function started(options: { readonly mapping?: ReturnType<typeof mappingOf>; readonly catalog?: TemplateCatalog } = {}) {
  const mapping = options.mapping ?? mappingOf();
  const [source] = mapping.sources;
  if (source === undefined) throw new Error('the mapping has no source');
  const answer = (call: ExecuteCall): Promise<ExecuteOutcome> => Promise.resolve({ status: 'rows', rows: call.templateId === 'linked-entities-count' ? [{ matches: 0, frontierBounded: false, supernodeSkipped: false }] : call.templateId === 'shared-attribute-count' ? [{ matches: 0, anchorBounded: false, skipped: false }] : call.templateId === 'linked-entities' ? [linkedRow({ match: 'O-1' })] : [sharedRow({ match: 'O-1' })] });
  const executor = new TestExecutor(withSchema(() => schemaAnswer(onlineIndexesOf(source)), answer));
  const seams = communitySeams();
  const parts = testSourceGate(mapping, { executor, ...(options.catalog === undefined ? {} : { catalog: options.catalog }) });
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping, gate: parts.gate, seams, catalog: parts.catalog });
  return { app, executor, parts };
}

type Started = Awaited<ReturnType<typeof started>>;
const list = (app: Started['app'], query = '?sourceId=demo') => app.inject({ method: 'GET', url: `/v1/templates${query}` });
const codeOf = (response: { json(): unknown }): unknown => (response.json() as { error?: { code?: unknown } }).error?.code;

describe('GET /v1/templates', () => {
  it('lists the built-in templates a pattern can bind, in order, with the name, version and description of the catalog, and the presets of the source as its profile gives them', async () => {
    const { app } = await started();
    const response = await list(app);
    expect(response.statusCode).toBe(200);
    const body = templateListResponseSchema.parse(response.json());
    expect(body.sourceId).toBe('demo');
    expect(body.templates.map((template) => template.id)).toEqual([...PRESET_TEMPLATES]);
    expect(body.templates.map((template) => template.name)).toEqual(['Shared attribute', 'Linked entities']);
    for (const template of body.templates) {
      expect(template.version).toBe('1');
      expect(template.description.length).toBeGreaterThan(20);
    }
    const [source] = mappingOf().sources;
    expect(body.presets).toEqual(source === undefined ? [] : presetProfilesOf(source));
    expect(body.presets.map((preset) => preset.id)).toEqual([LINKED_PRESET.id, SHARED_PRESET.id]);
    await app.close();
  });

  it('does not list the count each pattern template reads before it runs, by ID or in any text', async () => {
    const { app } = await started();
    const text = (await list(app)).body;
    for (const id of ['shared-attribute-count', 'linked-entities-count']) expect(text).not.toContain(id);
    await app.close();
  });

  it('lists no preset for a source that declares none, and still every template with its generic name', async () => {
    const { app } = await started({ mapping: mappingOf([]) });
    const body = templateListResponseSchema.parse((await list(app)).json());
    expect(body.presets).toEqual([]);
    expect(body.templates.map((template) => template.name)).toEqual(['Shared attribute', 'Linked entities']);
    await app.close();
  });

  it.each([
    ['an unknown source', '?sourceId=nowhere', 404, 'NOT_FOUND'],
    ['no source', '', 400, 'INVALID_REQUEST'],
    ['an empty source', '?sourceId=', 400, 'INVALID_REQUEST'],
    ['a repeated source', '?sourceId=demo&sourceId=demo', 400, 'INVALID_REQUEST'],
    ['an unknown query member', '?sourceId=demo&other=1', 400, 'INVALID_REQUEST'],
  ])('answers %s with %s', async (_name, query, status, code) => {
    const { app } = await started();
    const response = await list(app, query);
    expect({ status: response.statusCode, code: codeOf(response) }).toEqual({ status, code });
    await app.close();
  });

  it('reads no source: the executor is never called, however often the list is asked for', async () => {
    const { app, executor } = await started();
    for (let i = 0; i < 3; i += 1) await list(app);
    expect(executor.calls).toEqual([]);
    await app.close();
  });

  it('leaves out a template the catalog the gate validates against does not allow for the source, which the gate then refuses', async () => {
    const catalog = createTemplateCatalog({ templates: defaultCatalogTemplates(), isEnabled: (templateId) => templateId !== 'linked-entities' });
    const { app } = await started({ catalog });
    const body = templateListResponseSchema.parse((await list(app)).json());
    expect(body.templates.map((template) => template.id)).toEqual(['shared-attribute']);
    const refused = await app.inject({ method: 'POST', url: '/v1/templates/linked-entities/run', payload: { sourceId: 'demo', params: { ref: { entityType: 'maker', stableId: 'A-1' }, targetType: 'maker', via: ['LINKS'] } }, headers: { 'idempotency-key': 'a-key-of-sixteen-chars-x' } });
    expect({ status: refused.statusCode, code: codeOf(refused) }).toEqual({ status: 400, code: 'INVALID_REQUEST' });
    await app.close();
  });
});

describe('the parameter schema of each listed template', () => {
  it('is what Zod writes from the one contract schema of the template, and no conversion throws', async () => {
    const { app } = await started();
    const body = templateListResponseSchema.parse((await list(app)).json());
    for (const template of body.templates) {
      expect(template.paramsSchema).toEqual(paramsJsonSchemaOf(template.id));
      expect(() => z.toJSONSchema(TEMPLATE_PARAMS_SCHEMAS[template.id], { io: 'input', unrepresentable: 'throw' })).not.toThrow();
    }
    await app.close();
  });

  it('is the same exported schema the run route parses with', () => {
    expect(Object.keys(TEMPLATE_PARAMS_SCHEMAS).sort()).toEqual([...PRESET_TEMPLATES].sort());
    expect(TEMPLATE_PARAMS_SCHEMAS['shared-attribute']).toBe(sharedAttributeParamsSchema);
    expect(TEMPLATE_PARAMS_SCHEMAS['linked-entities']).toBe(linkedEntitiesParamsSchema);
  });
});

interface Sample {
  readonly name: string;
  readonly id: string;
  readonly template: 'shared-attribute' | 'linked-entities';
  readonly params: Record<string, unknown>;
  /** What the JSON Schema says about `params`. */
  readonly schema: 'accepts' | 'refuses';
  readonly status: number;
  readonly code?: string;
}

const REF = { entityType: 'maker', stableId: 'A-1' };
const SHARED = { ref: REF, attributeType: 'tool', via: 'USES_TOOL' };
const LINKED = { ref: REF, targetType: 'maker', via: ['LINKS'] };
const sample = (template: Sample['template'], id: string, name: string, params: Record<string, unknown>, schema: Sample['schema'], status: number, code?: string): Sample => ({ name, id, template, params, schema, status, ...(code === undefined ? {} : { code }) });

const SAMPLES: readonly Sample[] = [
  // what the route accepts: the schema accepts it too
  sample('shared-attribute', 'shared-attribute', 'the anchor, the attribute type and the relationship type', SHARED, 'accepts', 200),
  sample('shared-attribute', 'shared-attribute', 'every optional parameter, a window of days', { ...SHARED, window: { days: 14 }, minShared: 3, limit: 10 }, 'accepts', 200),
  sample('shared-attribute', 'shared-attribute', 'a window of dates', { ...SHARED, window: { from: '2026-01-01', to: '2026-01-31' } }, 'accepts', 200),
  sample('shared-attribute', SHARED_PRESET.id, 'the anchor alone for a preset', { ref: REF }, 'accepts', 200),
  sample('linked-entities', 'linked-entities', 'the anchor, the target type and the relationship types', LINKED, 'accepts', 200),
  sample('linked-entities', 'linked-entities', 'every optional parameter', { ...LINKED, direction: 'both', maxHops: 2, window: { days: 30 }, limit: 10 }, 'accepts', 200),
  sample('linked-entities', LINKED_PRESET.id, 'the anchor alone for a preset', { ref: REF }, 'accepts', 200),
  // refused by the schema and by the route alike: a shape, a type, a bound
  sample('shared-attribute', 'shared-attribute', 'no anchor', { attributeType: 'tool', via: 'USES_TOOL' }, 'refuses', 400, 'INVALID_REQUEST'),
  sample('shared-attribute', 'shared-attribute', 'a member the schema does not name', { ...SHARED, cypher: 'MATCH (n) RETURN n' }, 'refuses', 400, 'INVALID_REQUEST'),
  sample('shared-attribute', 'shared-attribute', 'a minimum of shared nodes that is text', { ...SHARED, minShared: '3' }, 'refuses', 400, 'INVALID_REQUEST'),
  sample('shared-attribute', 'shared-attribute', 'a minimum one over its bound', { ...SHARED, minShared: 51 }, 'refuses', 400, 'INVALID_REQUEST'),
  sample('shared-attribute', 'shared-attribute', 'a minimum of none', { ...SHARED, minShared: 0 }, 'refuses', 400, 'INVALID_REQUEST'),
  sample('shared-attribute', 'shared-attribute', 'days one over the bound', { ...SHARED, window: { days: 3651 } }, 'refuses', 400, 'INVALID_REQUEST'),
  sample('shared-attribute', 'shared-attribute', 'a limit of none', { ...SHARED, limit: 0 }, 'refuses', 400, 'INVALID_REQUEST'),
  sample('linked-entities', 'linked-entities', 'an empty list of relationship types', { ...LINKED, via: [] }, 'refuses', 400, 'INVALID_REQUEST'),
  sample('linked-entities', 'linked-entities', 'a direction outside the closed set', { ...LINKED, direction: 'sideways' }, 'refuses', 400, 'INVALID_REQUEST'),
  sample('linked-entities', 'linked-entities', 'hops one over the contract bound', { ...LINKED, maxHops: 5 }, 'refuses', 400, 'INVALID_REQUEST'),
  sample('linked-entities', 'linked-entities', 'hops of none', { ...LINKED, maxHops: 0 }, 'refuses', 400, 'INVALID_REQUEST'),
  sample('shared-attribute', 'shared-attribute', 'an empty entity type', { ...SHARED, ref: { entityType: '', stableId: 'A-1' } }, 'refuses', 400, 'INVALID_REQUEST'),
  sample('shared-attribute', 'shared-attribute', 'an empty stable ID', { ...SHARED, ref: { entityType: 'maker', stableId: '' } }, 'refuses', 400, 'INVALID_REQUEST'),
  sample('shared-attribute', 'shared-attribute', 'an empty attribute type', { ...SHARED, attributeType: '' }, 'refuses', 400, 'INVALID_REQUEST'),
  sample('shared-attribute', 'shared-attribute', 'a stable ID that is a number', { ...SHARED, ref: { entityType: 'maker', stableId: 7 } }, 'refuses', 400, 'INVALID_REQUEST'),
  sample('linked-entities', 'linked-entities', 'no anchor', { targetType: 'maker', via: ['LINKS'] }, 'refuses', 400, 'INVALID_REQUEST'),
  sample('linked-entities', 'linked-entities', 'a member the schema does not name', { ...LINKED, cypher: 'MATCH (n) RETURN n' }, 'refuses', 400, 'INVALID_REQUEST'),
  sample('linked-entities', 'linked-entities', 'a relationship type that is text, not a list', { ...LINKED, via: 'LINKS' }, 'refuses', 400, 'INVALID_REQUEST'),
  sample('linked-entities', 'linked-entities', 'an empty target type', { ...LINKED, targetType: '' }, 'refuses', 400, 'INVALID_REQUEST'),
  sample('linked-entities', 'linked-entities', 'an empty relationship type in the list', { ...LINKED, via: [''] }, 'refuses', 400, 'INVALID_REQUEST'),
  sample('linked-entities', 'linked-entities', 'an empty entity type', { ...LINKED, ref: { entityType: '', stableId: 'A-1' } }, 'refuses', 400, 'INVALID_REQUEST'),
  sample('linked-entities', 'linked-entities', 'an empty stable ID', { ...LINKED, ref: { entityType: 'maker', stableId: '' } }, 'refuses', 400, 'INVALID_REQUEST'),
  sample('linked-entities', 'linked-entities', 'a limit of none', { ...LINKED, limit: 0 }, 'refuses', 400, 'INVALID_REQUEST'),
  // server-only rules: the schema accepts them and the route refuses them, with the code it gives
  sample('shared-attribute', 'shared-attribute', 'a date that is not on the calendar', { ...SHARED, window: { from: '2026-02-30', to: '2026-03-01' } }, 'accepts', 400, 'INVALID_REQUEST'),
  sample('shared-attribute', 'shared-attribute', 'a range of dates in the wrong order', { ...SHARED, window: { from: '2026-01-31', to: '2026-01-01' } }, 'accepts', 400, 'INVALID_REQUEST'),
  sample('shared-attribute', 'shared-attribute', 'a range of dates wider than the bound', { ...SHARED, window: { from: '2000-01-01', to: '2026-01-01' } }, 'accepts', 400, 'INVALID_REQUEST'),
  sample('shared-attribute', SHARED_PRESET.id, 'a preset that receives the attribute type', { ref: REF, attributeType: 'tool' }, 'accepts', 400, 'INVALID_REQUEST'),
  sample('shared-attribute', SHARED_PRESET.id, 'a preset that receives the relationship type', { ref: REF, via: 'USES_TOOL' }, 'accepts', 400, 'INVALID_REQUEST'),
  sample('shared-attribute', SHARED_PRESET.id, 'a preset and an anchor of another type', { ref: { entityType: 'tool', stableId: 'D-1' } }, 'accepts', 400, 'INVALID_REQUEST'),
  sample('shared-attribute', 'shared-attribute', 'the template ID with no attribute type', { ref: REF, via: 'USES_TOOL' }, 'accepts', 400, 'INVALID_REQUEST'),
  sample('shared-attribute', 'shared-attribute', 'the template ID with no relationship type', { ref: REF, attributeType: 'tool' }, 'accepts', 400, 'INVALID_REQUEST'),
  sample('shared-attribute', 'shared-attribute', 'an entity type the mapping does not have', { ...SHARED, ref: { entityType: 'nothing', stableId: 'A-1' } }, 'accepts', 404, 'NOT_FOUND'),
  sample('shared-attribute', 'shared-attribute', 'an attribute type the mapping does not have', { ...SHARED, attributeType: 'nothing' }, 'accepts', 400, 'INVALID_REQUEST'),
  sample('shared-attribute', 'shared-attribute', 'a limit above the page of the source', { ...SHARED, limit: 51 }, 'accepts', 422, 'QUERY_BUDGET_EXCEEDED'),
  sample('linked-entities', LINKED_PRESET.id, 'a preset that receives the target type', { ref: REF, targetType: 'maker' }, 'accepts', 400, 'INVALID_REQUEST'),
  sample('linked-entities', LINKED_PRESET.id, 'a preset that receives the relationship types', { ref: REF, via: ['LINKS'] }, 'accepts', 400, 'INVALID_REQUEST'),
  sample('linked-entities', LINKED_PRESET.id, 'a preset and an anchor of another type', { ref: { entityType: 'tool', stableId: 'D-1' } }, 'accepts', 400, 'INVALID_REQUEST'),
  sample('linked-entities', 'linked-entities', 'the template ID with no target type', { ref: REF, via: ['LINKS'] }, 'accepts', 400, 'INVALID_REQUEST'),
  sample('linked-entities', 'linked-entities', 'the template ID with no relationship types', { ref: REF, targetType: 'maker' }, 'accepts', 400, 'INVALID_REQUEST'),
  sample('linked-entities', 'linked-entities', 'three hops, above the cap of the template and within the contract bound', { ...LINKED, maxHops: 3 }, 'accepts', 422, 'QUERY_BUDGET_EXCEEDED'),
  sample('linked-entities', 'linked-entities', 'a duplicate relationship type', { ...LINKED, via: ['LINKS', 'LINKS'] }, 'accepts', 400, 'INVALID_REQUEST'),
  sample('linked-entities', 'linked-entities', 'a relationship type the mapping does not have', { ...LINKED, via: ['NOTHING'] }, 'accepts', 400, 'INVALID_REQUEST'),
  sample('linked-entities', 'linked-entities', 'a relationship type that does not join the anchor to the target', { ...LINKED, via: ['USES_TOOL'] }, 'accepts', 400, 'INVALID_REQUEST'),
  sample('linked-entities', 'linked-entities', 'a limit above the page of the source', { ...LINKED, limit: 51 }, 'accepts', 422, 'QUERY_BUDGET_EXCEEDED'),
  sample('linked-entities', 'linked-entities', 'relationship types stored in both directions from the anchor, with no direction given', { ...LINKED, via: ['LINKS', 'ENDORSES'] }, 'accepts', 400, 'INVALID_REQUEST'),
];

describe('the parameter schema of the list against the run route', () => {
  it('passes every input the run route accepts, and the route also refuses what the schema accepts, each with its code', async () => {
    const { app } = await started();
    const body = templateListResponseSchema.parse((await list(app)).json());
    const ajv = new Ajv2020({ strict: false });
    const validators = new Map(body.templates.map((template) => [template.id, ajv.compile(template.paramsSchema)]));
    let key = 0;
    const observed: { name: string; schema: string; status: number; code?: unknown }[] = [];
    for (const each of SAMPLES) {
      const validate = validators.get(each.template);
      if (validate === undefined) throw new Error(`no schema for ${each.template}`);
      const response = await app.inject({ method: 'POST', url: `/v1/templates/${each.id}/run`, payload: { sourceId: 'demo', params: each.params }, headers: { 'idempotency-key': `round-trip-key-of-sixteen-${(key += 1)}` } });
      const verdict = validate(each.params) ? 'accepts' : 'refuses';
      observed.push({ name: each.name, schema: verdict, status: response.statusCode, ...(response.statusCode === 200 ? {} : { code: codeOf(response) }) });
      if (response.statusCode === 200) expect(verdict, `${each.name}: the route accepts it and the schema must`).toBe('accepts');
      if (verdict === 'refuses') expect(response.statusCode, `${each.name}: the schema refuses it and the route must`).not.toBe(200);
    }
    expect(observed).toEqual(SAMPLES.map((each) => ({ name: each.name, schema: each.schema, status: each.status, ...(each.code === undefined ? {} : { code: each.code }) })));
    expect(SAMPLES.filter((each) => each.status === 200)).toHaveLength(7);
    await app.close();
  });

  it('accepts a window the mapping cannot apply, which the route refuses: no listed relationship type has a time property', async () => {
    const bare = linkedMappingOf({ relationships: DATED.map(({ observed_at: _observedAt, ...row }) => row), patterns: [LINKED_PRESET, SHARED_PRESET] });
    const { app } = await started({ mapping: bare });
    const body = templateListResponseSchema.parse((await list(app)).json());
    const ajv = new Ajv2020({ strict: false });
    const windowed = [
      ['shared-attribute', { ...SHARED, window: { days: 7 } }],
      ['linked-entities', { ...LINKED, window: { days: 7 } }],
    ] as const;
    let key = 0;
    for (const [id, params] of windowed) {
      const schema = body.templates.find((template) => template.id === id)?.paramsSchema ?? {};
      expect(ajv.compile(schema)(params)).toBe(true);
      const response = await app.inject({ method: 'POST', url: `/v1/templates/${id}/run`, payload: { sourceId: 'demo', params }, headers: { 'idempotency-key': `undated-key-of-sixteen-${(key += 1)}` } });
      expect({ status: response.statusCode, code: codeOf(response) }).toEqual({ status: 400, code: 'INVALID_REQUEST' });
    }
    await app.close();
  });

  it('accepts a stable ID within the bound counted in code points and over it counted in UTF-16 units, which the contract refuses and the server refuses before the route reads it', async () => {
    const { app } = await started();
    const body = templateListResponseSchema.parse((await list(app)).json());
    const validate = new Ajv2020({ strict: false }).compile(body.templates[0]?.paramsSchema ?? {});
    const astral = '\u{1F600}'.repeat(266_691);
    const params = { ref: { entityType: 'maker', stableId: astral } };
    expect(validate(params)).toBe(true);
    expect(referenceTextSchema.safeParse(astral).success).toBe(false);
    const response = await app.inject({ method: 'POST', url: `/v1/templates/${SHARED_PRESET.id}/run`, payload: { sourceId: 'demo', params }, headers: { 'idempotency-key': 'astral-key-of-sixteen-chars' } });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.statusCode).toBeLessThan(500);
    expect(codeOf(response)).toBe('INVALID_REQUEST');
    await app.close();
  });
});
