import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { parseMapping } from '../mapping/load.js';
import { fakeClock, gateRequest, harness, LOCAL_PRINCIPAL, TEST_CURSOR_KEY, TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { normalizedOf, onlineIndexesOf, searchModelOf, type StoredNode, type StoredRelationship } from '../testing/search-fixtures.js';
import { allowlistFromMapping } from './allowlist.js';
import { CatalogError, createTemplateCatalog, type TemplateDefinition } from './catalog.js';
import { createCursorCodec, CURSOR_TTL_MS, type CursorPosition } from './cursor/codec.js';
import type { ExecuteCall, ExecuteOutcome } from './executor.js';
import { normalizeModelOf } from './normalize/model.js';
import { SEARCH_EVIDENCE_ID, searchEvidenceTemplate } from './templates/search-evidence.js';
import { SEARCH_EXACT_ID, searchExactTemplate } from './templates/search-exact.js';
import { SEARCH_PREFIX_ID, searchPrefixTemplate } from './templates/search-prefix.js';
import { SEARCH_RELATED_ID, searchRelatedTemplate } from './templates/search-related.js';
import type { GatePage } from './types.js';

const mapping = parseMapping(
  fileOf(
    baseSource({
      id: 'demo',
      entities: [
        { type: 'widget', label: 'Widget', stable_id: 'widgetId', search: ['widgetId', 'nickname'], reference: ['batchRef', 'ownerRef'] },
        { type: 'gadget', label: 'Gadget', stable_id: 'gadgetId', search: ['gadgetId', 'region'] },
      ],
      relationships: [{ type: 'MADE_FROM', from: 'widget', to: 'gadget', stable_id: 'linkId', evidence: ['recordId', 'docId'] }],
    }),
  ),
  'neburyx.yaml',
);
const [source] = mapping.sources;
if (source === undefined) throw new Error('the mapping has no source');
const catalog = createTemplateCatalog({ templates: [searchExactTemplate, searchRelatedTemplate, searchPrefixTemplate, searchEvidenceTemplate] });
const ONLINE = { sourceId: source.id, entries: onlineIndexesOf(source).map((row) => ({ ...row })) };
const TEXT = 'needle';
const MATCHES = 61;

/** The element IDs of the matches, put in the store out of their order so that the order of a page is the read's and not the store's. */
const shuffled = <Value>(values: readonly Value[]): Value[] => values.map((value, index) => ({ value, key: (index * 37) % values.length })).sort((first, second) => first.key - second.key).map((entry) => entry.value);
const elementIdOf = (index: number): string => `4:n:${index}`;

const widgetsCarrying = (property: string, value: (index: number) => string): StoredNode[] =>
  Array.from({ length: MATCHES }, (_, index) => ({ elementId: elementIdOf(index), label: 'Widget', properties: { widgetId: `W-${index}`, [property]: value(index) } }));

const GADGET: StoredNode = { elementId: '4:g:0', label: 'Gadget', properties: { gadgetId: 'GD-0' } };
const relationships: StoredRelationship[] = Array.from({ length: MATCHES }, (_, index) => ({
  elementId: `5:r:${index}`,
  type: 'MADE_FROM',
  from: { elementId: elementIdOf(index), label: 'Widget', properties: { widgetId: `W-${index}` } },
  to: GADGET,
  properties: { linkId: `L-${index}`, recordId: TEXT },
}));

interface Case {
  readonly name: string;
  readonly templateId: string;
  readonly params: Record<string, unknown>;
  readonly stored: readonly StoredNode[];
  readonly idsOf: (page: GatePage) => readonly string[];
}

const nodeIds = (page: GatePage): readonly string[] => normalizedOf(page).nodes.map((node) => node.ref.stableId);
const edgeIds = (page: GatePage): readonly string[] => normalizedOf(page).edges.flatMap((edge) => ('stableId' in edge.ref ? [edge.ref.stableId] : []));

const CASES: readonly Case[] = [
  { name: 'the exact search', templateId: SEARCH_EXACT_ID, params: { text: TEXT, targets: [{ entityType: 'widget', property: 'nickname', match: 'value' }, { entityType: 'gadget', property: 'region', match: 'value' }] }, stored: shuffled(widgetsCarrying('nickname', () => TEXT)), idsOf: nodeIds },
  { name: 'the related lookup', templateId: SEARCH_RELATED_ID, params: { text: TEXT, targets: [{ entityType: 'widget', property: 'batchRef', match: 'value' }] }, stored: shuffled(widgetsCarrying('batchRef', () => TEXT)), idsOf: nodeIds },
  { name: 'the evidence lookup', templateId: SEARCH_EVIDENCE_ID, params: { text: TEXT, targets: [{ relationshipType: 'MADE_FROM', from: 'widget', to: 'gadget', property: 'recordId', match: 'value' }] }, stored: [], idsOf: edgeIds },
];

function rig(stored: readonly StoredNode[], respond?: (call: ExecuteCall) => Promise<ExecuteOutcome> | undefined, clock = fakeClock()) {
  const model = searchModelOf(stored, () => undefined, shuffled(relationships));
  const executor = new TestExecutor((call) => respond?.(call) ?? model(call));
  const parts = harness({ catalog, executor, modelFor: () => normalizeModelOf(source), allowlistFor: () => allowlist, clock: clock.now });
  return { ...parts, clock };
}
const allowlist = allowlistFromMapping(source);

const read = (templateId: string, params: unknown, overrides: Parameters<typeof gateRequest>[0] = {}) => gateRequest({ sourceId: source.id, templateId, params, limit: 25, indexes: ONLINE, ...overrides });

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return error instanceof AppError ? error.code : 'not an AppError';
  }
}

/** The signed body of a cursor: readable, as the decisions of the format say, and checked by its signature. */
function bodyOf(cursor: string | undefined): Record<string, unknown> {
  const [, body] = (cursor ?? '').split('.');
  return JSON.parse(Buffer.from(body ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('the declaration of the search templates', () => {
  it.each([
    [SEARCH_EXACT_ID, 'n'],
    [SEARCH_RELATED_ID, 'n'],
    [SEARCH_EVIDENCE_ID, 'r'],
  ])('declares %s paged, bound to the element ID order, with ORDER BY elementId and LIMIT $limit + 1 in every branch and in the union', (id, variable) => {
    const template = catalog.find(id);
    expect(template?.paged).toBe(true);
    expect(template?.sort).toBe('elementId');
    const order = `ORDER BY elementId(${variable}) LIMIT $limit + 1`;
    for (const text of [template?.searchBranches?.value ?? '', template?.searchBranches?.text ?? '']) {
      expect(text).toContain(`($cursor IS NULL OR elementId(${variable}) > $cursor.after)`);
      expect(text).toContain(order);
    }
    expect(template?.cypher).toContain(`} WITH ${variable === 'n' ? 'n, collect(DISTINCT entityType) AS entityTypes' : 'r, a, b'} ${order}`);
  });

  const failure = (definition: TemplateDefinition): string => {
    try {
      createTemplateCatalog({ templates: [definition] });
    } catch (error) {
      if (error instanceof CatalogError) return error.message;
      throw error;
    }
    return 'accepted';
  };
  const branches = searchExactTemplate.searchBranches;
  if (branches === undefined) throw new Error('the search template has no branches');

  it('declares the type-ahead prefix read capped and not paged: its cut means a lower bound, and no branch nor the union reads a cursor or sorts before its limit', () => {
    const template = catalog.find(SEARCH_PREFIX_ID);
    expect(template?.paged).toBe(false);
    expect(template?.cutMeans).toBe('lowerBound');
    expect(template?.sort).toBeUndefined();
    expect(template?.nextPosition).toBeUndefined();
    for (const text of [template?.searchBranches?.value ?? '', template?.searchBranches?.text ?? '', template?.cypher ?? '']) {
      expect(text).toContain('LIMIT $limit + 1');
      expect(text).not.toMatch(/ORDER BY|\$cursor/);
    }
  });

  it('refuses a search template that is not paged, or binds another order, or says no next position', () => {
    expect(failure({ ...searchExactTemplate, paged: false, rows: 'one' })).toBe("the template entity-search has search branches and is neither paged by element ID nor declared cutMeans: 'lowerBound'");
    expect(failure({ ...searchExactTemplate, paged: false, cutMeans: 'duplicate' })).toBe("the template entity-search has search branches and is neither paged by element ID nor declared cutMeans: 'lowerBound'");
    expect(failure({ ...searchExactTemplate, sort: 'title' })).toBe('the template entity-search has search branches and is not paged by element ID');
    const { nextPosition: _removed, ...withoutPosition } = searchExactTemplate;
    expect(failure(withoutPosition)).toBe('the template entity-search has search branches and is not paged by element ID');
  });

  it('refuses a branch that does not read after the cursor or does not sort before its limit, and a union that is not sorted', () => {
    const unsorted = 'MATCH (n:@label) WHERE n.@property = $text AND ($cursor IS NULL OR elementId(n) > $cursor.after) RETURN n, @entityType AS entityType LIMIT $limit + 1';
    const noCursor = 'MATCH (n:@label) WHERE n.@property = $text WITH n ORDER BY elementId(n) LIMIT $limit + 1 RETURN n, @entityType AS entityType';
    const message = 'the template entity-search has a branch text that does not read the page after the cursor in ORDER BY elementId(n) LIMIT $limit + 1';
    expect(failure({ ...searchExactTemplate, searchBranches: { ...branches, text: unsorted } })).toBe(message);
    expect(failure({ ...searchExactTemplate, searchBranches: { ...branches, value: noCursor } })).toBe(message);
    expect(failure({ ...searchExactTemplate, cypher: 'CALL { @searchBranches(targets) } WITH n LIMIT $limit + 1 RETURN n' })).toBe('the template entity-search has search branches and its Cypher is not cut in ORDER BY elementId(n) LIMIT $limit + 1');
  });

  it('refuses a capped search template whose branch or statement reads a cursor or sorts before its limit', () => {
    const { sort: _sort, nextPosition: _position, ...capped } = { ...searchExactTemplate, paged: false, cutMeans: 'lowerBound' as const };
    const message = 'the template entity-search has search branches, is not paged and reads a cursor or sorts before its limit';
    expect(failure(capped)).toBe(message);
    const prefixBranches = searchPrefixTemplate.searchBranches;
    if (prefixBranches === undefined) throw new Error('the prefix template has no branches');
    const sorted = prefixBranches.value.replace('WITH n LIMIT', 'WITH n ORDER BY elementId(n) LIMIT');
    expect(failure({ ...searchPrefixTemplate, searchBranches: { ...prefixBranches, value: sorted } })).toBe(message.replace('entity-search', SEARCH_PREFIX_ID));
    expect(failure({ ...searchPrefixTemplate, cypher: searchPrefixTemplate.cypher.replace('LIMIT', 'ORDER BY elementId(n) LIMIT') })).toBe(message.replace('entity-search', SEARCH_PREFIX_ID));
  });

  it('refuses an evidence template that pages by the node and not the relationship', () => {
    const evidence = searchEvidenceTemplate.searchBranches;
    if (evidence === undefined) throw new Error('the evidence template has no branches');
    const byNode = evidence.value.replaceAll('elementId(r)', 'elementId(a)');
    expect(failure({ ...searchEvidenceTemplate, searchBranches: { ...evidence, value: byNode } })).toContain('does not read the page after the cursor in ORDER BY elementId(r)');
  });
});

describe.each(CASES)('$name read page by page', ({ templateId, params, stored, idsOf }) => {
  it('signs the next cursor for this source, person, template, parameters and sort, holding the element ID of the last row shown', async () => {
    const { gate, executor } = rig(stored);
    const page = await gate.run(read(templateId, params));
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    const body = bodyOf(page.nextCursor);
    expect(body).toMatchObject({ s: source.id, p: LOCAL_PRINCIPAL.id, o: 'elementId', t: templateId, f: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(executor.calls).toHaveLength(1);
    // the last row shown is the 25th match in element ID order; the 26th only says there is more
    const order = (templateId === SEARCH_EVIDENCE_ID ? relationships : stored).map((value) => value.elementId).sort();
    expect(body['d']).toEqual({ after: order[24], held: 25 });
    expect(executor.calls[0]?.parameters['cursor']).toBeNull();
  });

  it('reads the rows after the cursor only, so three pages over 61 matches return each once, none skipped, in element ID order', async () => {
    const { gate, executor } = rig(stored);
    const first = await gate.run(read(templateId, params));
    const second = await gate.run(read(templateId, params, { cursor: first.nextCursor }));
    const third = await gate.run(read(templateId, params, { cursor: second.nextCursor }));
    expect([idsOf(first).length, idsOf(second).length, idsOf(third).length]).toEqual([25, 25, 11]);
    expect([first.hasMore, second.hasMore, third.hasMore]).toEqual([true, true, false]);
    expect(third.nextCursor).toBeUndefined();
    const all = [...idsOf(first), ...idsOf(second), ...idsOf(third)];
    expect(new Set(all).size).toBe(MATCHES);
    // the hits held travel in the cursor for the gate alone: the statement reads the keyset only
    expect(executor.calls[1]?.parameters['cursor']).toEqual({ after: (bodyOf(first.nextCursor)['d'] as { after: string }).after });
    expect([first.held, second.held, third.held]).toEqual([25, 50, 61]);
    expect(bodyOf(second.nextCursor)['d']).toMatchObject({ held: 50 });
    const after = String((bodyOf(first.nextCursor)['d'] as { after: string }).after);
    const afterSecond = String((bodyOf(second.nextCursor)['d'] as { after: string }).after);
    expect(after < afterSecond).toBe(true);
  });

  it('refuses a cursor from another text, another source, another person, another group or with a changed byte, as CURSOR_INVALIDATED and without reading', async () => {
    const { gate, executor } = rig(stored);
    const first = await gate.run(read(templateId, params));
    const cursor = first.nextCursor ?? '';
    const changed = cursor.slice(0, 10) + (cursor[10] === 'A' ? 'B' : 'A') + cursor.slice(11);
    const otherTemplate = templateId === SEARCH_RELATED_ID ? SEARCH_EXACT_ID : SEARCH_RELATED_ID;
    const otherParams = otherTemplate === SEARCH_RELATED_ID ? { text: TEXT, targets: [{ entityType: 'widget', property: 'batchRef', match: 'value' }] } : { text: TEXT, targets: [{ entityType: 'widget', property: 'nickname', match: 'value' }] };
    const refused = [
      read(templateId, { ...params, text: `${String(params['text'])}x` }, { cursor }),
      read(templateId, params, { cursor, sourceId: 'another-source', indexes: { ...ONLINE, sourceId: 'another-source' } }),
      read(templateId, params, { cursor, principal: { ...LOCAL_PRINCIPAL, id: 'another-person' } }),
      read(otherTemplate, otherParams, { cursor }),
      read(templateId, params, { cursor: changed }),
    ];
    const calls = executor.calls.length;
    for (const request of refused) expect(await codeOf(gate.run(request))).toBe('CURSOR_INVALIDATED');
    expect(executor.calls).toHaveLength(calls);
  });

  it('refuses a cursor whose count of hits held was edited, and a signed position without a whole, non-negative count, as CURSOR_INVALIDATED and without reading', async () => {
    const { gate, executor, clock } = rig(stored);
    const first = await gate.run(read(templateId, params));
    const [version, , mac] = (first.nextCursor ?? '').split('.');
    const body = bodyOf(first.nextCursor);
    const position = body['d'] as Record<string, unknown>;
    const edited = `${version}.${Buffer.from(JSON.stringify({ ...body, d: { ...position, held: 0 } }), 'utf8').toString('base64url')}.${mac}`;
    // a cursor signed with the gate's own key and binding, so only the gate's reading of the count refuses it
    const codec = createCursorCodec({ key: TEST_CURSOR_KEY, clock: clock.now });
    const binding = { source: String(body['s']), principal: String(body['p']), policyVersion: String(body['pv']), filterHash: String(body['f']), sort: String(body['o']), target: String(body['t']), targetVersion: String(body['tv']) };
    const after = String(position['after']);
    const positions: readonly CursorPosition[] = [{ after }, { after, held: -1 }, { after, held: 2.5 }, { after, held: '25' }];
    const signed = positions.map((positionOf) => codec.mint(binding, positionOf));
    expect(await gate.run(read(templateId, params, { cursor: codec.mint(binding, { after, held: 25 }) }))).toMatchObject({ held: 50 });
    const calls = executor.calls.length;
    for (const cursor of [edited, ...signed]) expect(await codeOf(gate.run(read(templateId, params, { cursor })))).toBe('CURSOR_INVALIDATED');
    expect(executor.calls).toHaveLength(calls);
  });

  it('refuses a cursor once it has expired', async () => {
    const { gate, clock } = rig(stored);
    const first = await gate.run(read(templateId, params));
    clock.advance(CURSOR_TTL_MS);
    expect(await codeOf(gate.run(read(templateId, params, { cursor: first.nextCursor })))).toBe('CURSOR_INVALIDATED');
  });

  it('fails a page whose sorted read exceeds the transaction timeout with QUERY_TIMEOUT and its budget, returns no row, and keeps the cursor of the previous page usable', async () => {
    let timeouts = 1;
    const { gate } = rig(stored, (call) => (call.parameters['cursor'] !== null && timeouts-- > 0 ? Promise.resolve({ status: 'timeout' }) : undefined));
    const first = await gate.run(read(templateId, params));
    const failed = await gate.run(read(templateId, params, { cursor: first.nextCursor })).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failed).toBeInstanceOf(AppError);
    expect(failed).toMatchObject({ code: 'QUERY_TIMEOUT', details: { timeoutMs: 5000 } });
    const retried = await gate.run(read(templateId, params, { cursor: first.nextCursor }));
    expect(idsOf(retried)).toHaveLength(25);
    expect(idsOf(retried).some((id) => idsOf(first).includes(id))).toBe(false);
  });
});

describe('a node found through two properties', () => {
  it('is on one page only, once, when the pages are read', async () => {
    const both: StoredNode[] = Array.from({ length: 30 }, (_, index) => ({ elementId: elementIdOf(index), label: 'Widget', properties: { widgetId: index === 7 ? TEXT : `W-${index}`, nickname: TEXT } }));
    const { gate } = rig(both);
    const params = { text: TEXT, targets: [{ entityType: 'widget', property: 'widgetId', match: 'value' }, { entityType: 'widget', property: 'nickname', match: 'value' }] };
    const first = await gate.run(read(SEARCH_EXACT_ID, params));
    const second = await gate.run(read(SEARCH_EXACT_ID, params, { cursor: first.nextCursor }));
    const all = [...nodeIds(first), ...nodeIds(second)];
    expect(all).toHaveLength(30);
    expect(all.filter((id) => id === TEXT)).toHaveLength(1);
  });
});

describe('the type-ahead prefix read through the gate', () => {
  const params = { text: 'nee', targets: [{ entityType: 'widget', property: 'nickname', match: 'value' }] };
  const stored = shuffled(widgetsCarrying('nickname', (index) => `needle-${index}`));

  it('answers a cut read with its rows, hasMore and no cursor, so its count is a lower bound of the rows held', async () => {
    const { gate, executor } = rig(stored);
    const page = await gate.run(read(SEARCH_PREFIX_ID, params));
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBeUndefined();
    expect(nodeIds(page)).toHaveLength(25);
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]?.parameters).not.toHaveProperty('cursor');
  });

  it('answers a read that is not cut with every match, no more and no cursor', async () => {
    const { gate } = rig(stored.slice(0, 10));
    const page = await gate.run(read(SEARCH_PREFIX_ID, params));
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeUndefined();
    expect(nodeIds(page)).toHaveLength(10);
  });

  it('refuses a request that carries a cursor as INVALID_REQUEST, without reading', async () => {
    const { gate, executor } = rig(stored);
    expect(await codeOf(gate.run(read(SEARCH_PREFIX_ID, params, { cursor: 'v1.a.b' })))).toBe('INVALID_REQUEST');
    expect(executor.calls).toEqual([]);
  });
});
