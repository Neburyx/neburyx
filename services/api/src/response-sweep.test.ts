import {
  coverageResponseSchema,
  readRefsResponseSchema,
  degreePreviewSchema,
  derivedNeighborsResponseSchema,
  edgeDetailSchema,
  edgeRefSegmentOf,
  errorResponseSchema,
  expandResponseSchema,
  nodeSchema,
  openInvestigationResponseSchema,
  searchMoreResultSchema,
  searchResultSchema,
  sourceLinkSegmentOf,
} from '@neburyx/contracts';
import type { ZodType } from 'zod';
import { registeredRoutesOf } from './app.js';
import { describe, expect, it } from 'vitest';
import type { ExecuteCall, ExecuteOutcome } from './gate/executor.js';
import { tokensOf } from './testing/fuzz-closed-set.js';
import { FUZZ_SOURCE, respond, startFuzzRig } from './testing/fuzz-rig.js';
import { plainNode, plainRelationship } from './testing/normalize-fixtures.js';
import { elementIdsIn, sweepFindings } from './testing/response-sweep.js';
import { postMore, postSearch, RELATED_ENTITIES, searchMappingOf, startSearchApp } from './testing/search-app.js';
import { searchModelOf, type StoredNode, type StoredRelationship } from './testing/search-fixtures.js';

/**
 * No response of any route of the inspector holds the element ID of the source's database: not as a field, not in a text, not in a header. Each route is asked once the way the inspector asks it, over
 * a source that answers with element IDs everywhere (nodes, relationships, paths), and every response is parsed with its strict contract schema (a field the contract does not name fails) and swept.
 */
const issued = new Set<string>();
const widgetNode = plainNode(['Widget'], { widgetId: 'W-1' }, '4:sweep:w1');
const gadgetNode = plainNode(['Gadget'], { gadgetId: 'GD-1' }, '4:sweep:g1');
const storedRow = { r: plainRelationship('MADE_FROM', widgetNode, gadgetNode, { linkId: 'L-1', recordId: 'R-1', seenAt: { $type: 'dateTime', value: '2026-03-01T10:00:00Z' } }, '5:sweep:l1'), a: widgetNode, b: gadgetNode };
/** The members of an aggregate as the source answers them: each row also holds the element ID of its relationship, which no answer may repeat. */
const withMemberIds = (outcome: ExecuteOutcome): ExecuteOutcome =>
  outcome.status === 'rows'
    ? { ...outcome, rows: outcome.rows.map((row) => (Array.isArray(row['sample']) ? { ...row, sample: row['sample'].map((member: object, index: number) => ({ ...member, elementId: `5:sweep:member${index}` })) } : row)) }
    : outcome;
const recording = async (call: ExecuteCall): Promise<ExecuteOutcome> => {
  const outcome = call.templateId === 'edge-load' ? ({ status: 'rows', rows: [storedRow] } as const) : call.templateId === 'aggregate-sample' ? withMemberIds(await respond(call)) : await respond(call);
  if (outcome.status === 'rows') elementIdsIn(outcome.rows, issued);
  return outcome;
};

const rig = await startFuzzRig({ respond: recording });
const entity = { sourceId: FUZZ_SOURCE, entityType: 'widget', stableId: 'W-1' };
const stored = { sourceId: FUZZ_SOURCE, type: 'MADE_FROM', from: 'widget', to: 'gadget', stableId: 'L-1' };
/** A handle (a keyed type) the source answers with, to name the far end of an aggregate. */
const handle = tokensOf(JSON.parse((await rig.app.inject({ method: 'POST', url: '/v1/graph/expand', payload: JSON.stringify({ sourceId: FUZZ_SOURCE, ref: { entityType: 'widget', stableId: 'W-1' }, neighborTypes: ['phone'], direction: 'out' }), headers: { 'content-type': 'application/json' } })).body))[0];
if (handle === undefined) throw new Error('the source answered no handle');
const aggregate = { sourceId: FUZZ_SOURCE, aggregate: { type: 'USES', from: entity, to: { sourceId: FUZZ_SOURCE, ...handle } } };
const derived = { sourceId: FUZZ_SOURCE, derived: { ruleId: 'shared-gadget', from: entity, to: { ...entity, stableId: 'W-2' } } };

interface Scenario {
  readonly name: string;
  /** The registered route the scenario asks. */
  readonly route: string;
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly payload?: unknown;
  readonly schema?: ZodType;
}

const SCENARIOS: readonly Scenario[] = [
  { name: 'entity read', route: 'GET /v1/entities/:sourceId/:entityType/:stableId', method: 'GET', url: `/v1/entities/${FUZZ_SOURCE}/widget/W-1`, schema: nodeSchema },
  { name: 'entity read, masked', route: 'GET /v1/entities/:sourceId/:entityType/:stableId', method: 'GET', url: `/v1/entities/${FUZZ_SOURCE}/widget/W-1?mask=true`, schema: nodeSchema },
  { name: 'entity lookup', route: 'POST /v1/entities/lookup', method: 'POST', url: '/v1/entities/lookup', payload: { sourceId: FUZZ_SOURCE, ref: { entityType: 'widget', stableId: 'W-1' } } },
  { name: 'stored relationship', route: 'GET /v1/edges/:ref', method: 'GET', url: `/v1/edges/${edgeRefSegmentOf(stored)}`, schema: edgeDetailSchema },
  { name: 'aggregate relationship', route: 'GET /v1/edges/:ref', method: 'GET', url: `/v1/edges/${edgeRefSegmentOf(aggregate)}`, schema: edgeDetailSchema },
  { name: 'aggregate relationship, masked', route: 'GET /v1/edges/:ref', method: 'GET', url: `/v1/edges/${edgeRefSegmentOf(aggregate)}?mask=true`, schema: edgeDetailSchema },
  { name: 'derived relationship', route: 'GET /v1/edges/:ref', method: 'GET', url: `/v1/edges/${edgeRefSegmentOf(derived)}`, schema: edgeDetailSchema },
  { name: 'source link of an entity', route: 'GET /v1/source-links/:ref', method: 'GET', url: `/v1/source-links/${sourceLinkSegmentOf({ form: 'entity', ref: entity })}` },
  { name: 'source link of a record', route: 'GET /v1/source-links/:ref', method: 'GET', url: `/v1/source-links/${sourceLinkSegmentOf({ form: 'stored', ref: stored })}?record=R-1` },
  { name: 'read by references', route: 'POST /v1/graph/read-refs', method: 'POST', url: '/v1/graph/read-refs', payload: { sourceId: FUZZ_SOURCE, entities: [{ sourceId: FUZZ_SOURCE, entityType: 'widget', stableId: 'W-1' }] }, schema: readRefsResponseSchema },
  { name: 'derived neighbors', route: 'POST /v1/graph/derived-neighbors', method: 'POST', url: '/v1/graph/derived-neighbors', payload: { sourceId: FUZZ_SOURCE, ref: { entityType: 'widget', stableId: 'W-1' } }, schema: derivedNeighborsResponseSchema },
  { name: 'degree preview', route: 'POST /v1/graph/preview-expansion', method: 'POST', url: '/v1/graph/preview-expansion', payload: { sourceId: FUZZ_SOURCE, ref: { entityType: 'widget', stableId: 'W-1' } }, schema: degreePreviewSchema },
  { name: 'expand', route: 'POST /v1/graph/expand', method: 'POST', url: '/v1/graph/expand', payload: { sourceId: FUZZ_SOURCE, ref: { entityType: 'widget', stableId: 'W-1' }, neighborTypes: ['gadget'], direction: 'out' }, schema: expandResponseSchema },
  { name: 'search', route: 'POST /v1/search/entities', method: 'POST', url: '/v1/search/entities', payload: { sourceId: FUZZ_SOURCE, text: 'needle' }, schema: searchResultSchema },
  { name: 'coverage', route: 'POST /v1/graph/coverage', method: 'POST', url: '/v1/graph/coverage', payload: { sourceId: FUZZ_SOURCE, entities: [{ ref: entity, loadedRelationships: 1, loadedQuality: 'exact' }] }, schema: coverageResponseSchema },
  { name: 'open investigation', route: 'POST /v1/investigations', method: 'POST', url: '/v1/investigations', payload: { sourceId: FUZZ_SOURCE, entity: { sourceId: FUZZ_SOURCE, entityType: 'widget', stableId: 'W-1' } }, schema: openInvestigationResponseSchema },
];

/** Routes no scenario asks, each with the reason: the next page of the search (its own describe below) and the routes that carry no element of the source. */
const NOT_SWEPT_HERE: Readonly<Record<string, string>> = {
  'POST /v1/search/entities/more': 'the next pages of the search are swept in the describe of the evidence group below',
  'GET /v1/me': 'answers the person, not an element of the source',
  'GET /v1/sources': 'answers the registry of sources, not an element of one',
  'GET /v1/sources/:id/profile': 'answers the mapping profile, not an element',
  'POST /v1/sources/:id/test': 'answers the report of the source test, not an element',
  'GET /v1/investigations': 'answers the person\'s saved investigations (references, never element IDs of the source)',
  'GET /v1/investigations/:id': 'answers a saved investigation (references, never element IDs of the source)',
  'PUT /v1/investigations/:id/draft': 'answers the new version of a draft and whether it equals a named view, no element ID',
};

/** The registered routes under /v1 that neither a scenario nor the list above names. */
const unswept = (registered: readonly { readonly method: string; readonly url: string }[], routes: readonly string[]): string[] =>
  registered.filter((route) => route.method !== 'HEAD' && route.url.startsWith('/v1')).map((route) => `${route.method} ${route.url}`).filter((key) => !routes.includes(key) && !(key in NOT_SWEPT_HERE));

const send = async (scenario: Scenario) =>
  rig.app.inject({ method: scenario.method, url: scenario.url, ...(scenario.payload === undefined ? {} : { payload: JSON.stringify(scenario.payload), headers: { 'content-type': 'application/json' } }) });

describe('no response of a route of the inspector holds an element ID of the source', () => {
  it('holds for each route, which is asked the way the inspector asks it and answers', async () => {
    for (const scenario of SCENARIOS) {
      const response = await send(scenario);
      // the source link redirects (302), the degree preview of the fuzz source finds no degree row (404, an answer like any other), and every other route is answered
      expect(response.statusCode, scenario.name).toBeLessThan(scenario.name === 'degree preview' ? 500 : 400);
      const contract = response.statusCode >= 400 ? errorResponseSchema : scenario.schema;
      if (contract !== undefined) expect(contract.safeParse(response.json()).success, `${scenario.name} is as its strict contract`).toBe(true);
      expect(sweepFindings(scenario.name, { body: response.body, headers: response.headers }, issued), scenario.name).toEqual([]);
    }
    expect(issued.size, 'the source answered with element IDs, so the sweep has something to look for').toBeGreaterThan(20);
    expect([...issued], 'the members of the aggregate carried element IDs the answer had to leave out').toContain('5:sweep:member0');
  });

  it('also holds for the refusals of those routes', async () => {
    for (const scenario of SCENARIOS) {
      const response = await send({ ...scenario, url: scenario.url.replace(/W-1|widget/, 'nobody'), ...(scenario.payload === undefined ? {} : { payload: { sourceId: 'nobody', ref: entity } }) });
      expect(sweepFindings(`${scenario.name}, refused`, { body: response.body, headers: response.headers }, issued)).toEqual([]);
    }
  });

  it('holds for the cursor of a next page: it is sealed, so the position it holds is not a field or a text of the response', async () => {
    const response = await send(SCENARIOS.find((scenario) => scenario.name === 'expand') as Scenario);
    const cursors = [...response.body.matchAll(/"[A-Za-z]*[cC]ursor":"([^"]+)"/g)].map((match) => match[1] ?? '');
    expect(cursors.length).toBeGreaterThan(0);
    for (const cursor of cursors) expect(cursor).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(sweepFindings('expand cursors', { body: response.body, headers: {} }, issued)).toEqual([]);
  });
});

describe('every route is swept', () => {
  it('names each registered route in a scenario or on the list with a reason, so a new route cannot return an element ID unseen', () => {
    const registered = registeredRoutesOf(rig.app);
    const asked = SCENARIOS.map((scenario) => scenario.route);
    expect(unswept(registered, asked)).toEqual([]);
    expect(unswept(registered, asked.filter((key) => key !== 'GET /v1/edges/:ref'))).toEqual(['GET /v1/edges/:ref']);
    expect(unswept([...registered, { method: 'GET', url: '/v1/new-read/:id' }], asked)).toEqual(['GET /v1/new-read/:id']);
    const keys = registered.map((route) => `${route.method} ${route.url}`);
    for (const key of [...asked, ...Object.keys(NOT_SWEPT_HERE)]) expect(keys, key).toContain(key);
  });
});

describe('the sweep fails for what it is for', () => {
  /** An element ID the source answered with, known once a route test has run (a probe asks for one itself when none has). */
  const idOf = async (): Promise<string> => {
    if (issued.size === 0) await send(SCENARIOS[0] as Scenario);
    return [...issued][0] ?? '';
  };
  const clean = { body: JSON.stringify({ ref: { stableId: 'W-1' } }), headers: {} };

  it('finds a field named for an element ID, whatever its value, at any depth', () => {
    for (const body of [{ elementId: 'x' }, { a: { b: [{ startElementId: 'x' }] } }, { member: { element_id: 1 } }, { 'Element ID': 'x' }]) {
      expect(sweepFindings('probe', { body: JSON.stringify(body), headers: {} }, new Set()), JSON.stringify(body)).not.toEqual([]);
    }
  });

  it('finds an element ID the source answered with, in a field of any name, in a text and in a header', async () => {
    const anElementId = await idOf();
    expect(anElementId).not.toBe('');
    expect(sweepFindings('probe', { body: JSON.stringify({ note: anElementId }), headers: {} }, issued)).not.toEqual([]);
    expect(sweepFindings('probe', { body: JSON.stringify({ title: `Member ${anElementId}` }), headers: {} }, issued)).not.toEqual([]);
    expect(sweepFindings('probe', { body: '{}', headers: { 'x-trace': anElementId } }, issued)).not.toEqual([]);
  });

  it('finds a plain position in a cursor, and not a sealed one', async () => {
    const anElementId = await idOf();
    expect(sweepFindings('probe', { body: JSON.stringify({ nextCursor: JSON.stringify({ after: anElementId }) }), headers: {} }, issued)).not.toEqual([]);
    expect(sweepFindings('probe', { body: JSON.stringify({ nextCursor: `v1.${Buffer.from(JSON.stringify({ after: anElementId })).toString('base64url')}.sig` }), headers: {} }, issued)).toEqual([]);
  });

  it('passes a response without either', () => {
    expect(sweepFindings('probe', clean, issued)).toEqual([]);
  });

  it('fails the route test for a response that gained a field with an element ID', async () => {
    const anElementId = await idOf();
    const response = await send(SCENARIOS[0] as Scenario);
    const widened = { ...response.json<Record<string, unknown>>(), source: { elementId: anElementId } };
    expect(nodeSchema.safeParse(widened).success, 'the strict contract refuses the new field').toBe(false);
    expect(sweepFindings('widened', { body: JSON.stringify(widened), headers: {} }, issued)).not.toEqual([]);
  });
});

describe('the evidence group of a search, where an aggregate lists its members', () => {
  const TEXT = 'REC-1';
  const widgetNode: StoredNode = { elementId: '4:s:1', label: 'Widget', properties: { widgetId: 'W-1' } };
  const gadgetNode: StoredNode = { elementId: '4:s:2', label: 'Gadget', properties: { gadgetId: 'GT-1' } };
  const seen = (index: number): StoredRelationship => ({ elementId: `5:n:${String(index).padStart(3, '0')}`, type: 'SEEN_WITH', from: widgetNode, to: gadgetNode, properties: { recordId: TEXT, seenAt: `2026-03-01T10:${String(index).padStart(2, '0')}:00Z` } });
  const mapping = searchMappingOf({ entities: RELATED_ENTITIES, relationships: [{ type: 'SEEN_WITH', from: 'widget', to: 'gadget', observed_at: 'seenAt', evidence: ['recordId'] }] });

  it('holds no element ID of a member on the first page or on the next, and no field for one', async () => {
    const relationships = Array.from({ length: 30 }, (_, index) => seen(index + 1));
    const { app } = await startSearchApp({ mapping, respond: searchModelOf([widgetNode, gadgetNode], () => undefined, relationships) });
    const ids = new Set(['5:n:001', '5:n:002', '5:n:026', '5:n:030', '4:s:1', '4:s:2']);
    const first = await postSearch(app, { sourceId: 'demo', text: TEXT });
    expect(first.statusCode).toBe(200);
    const answer = searchResultSchema.parse(first.json());
    expect(answer.evidence.hits.length).toBeGreaterThan(0);
    expect(sweepFindings('search, first page', { body: first.body, headers: first.headers }, ids)).toEqual([]);
    const next = await postMore(app, { sourceId: 'demo', text: TEXT, group: 'evidence', cursor: answer.evidence.nextCursor ?? '' });
    expect(next.statusCode).toBe(200);
    searchMoreResultSchema.parse(next.json());
    expect(sweepFindings('search, next page', { body: next.body, headers: next.headers }, ids)).toEqual([]);
    await app.close();
  });
});
