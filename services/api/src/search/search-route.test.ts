import { searchResultSchema, SEARCH_GROUP_CAP } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { normalizeModelOf } from '../gate/normalize/model.js';
import { normalizeRows } from '../gate/normalize/index.js';
import { plainNode } from '../testing/entity-fixtures.js';
import { postSearch, searchCalls, searchMappingOf, startSearchApp, widget, widgets } from '../testing/search-app.js';

const mapping = searchMappingOf();

async function started(rows: readonly Record<string, unknown>[] = [widget(1)], source = mapping, respond?: (call: ExecuteCall) => Promise<ExecuteOutcome>) {
  return startSearchApp({ rows, mapping: source, ...(respond === undefined ? {} : { respond }) });
}

const post = postSearch;
const mappingOf = searchMappingOf;

describe('POST /v1/search/entities refuses a request before any read', () => {
  it.each([
    ['an empty text', { sourceId: 'demo', text: '' }],
    ['a targets field', { sourceId: 'demo', text: 'ab', targets: [{ entityType: 'widget', property: 'widgetId', match: 'value' }] }],
    ['an entity type', { sourceId: 'demo', text: 'ab', entityType: 'widget' }],
    ['a property', { sourceId: 'demo', text: 'ab', property: 'ownerName' }],
    ['a text of 201 characters', { sourceId: 'demo', text: 'a'.repeat(201) }],
    ['a field the contract does not name', { sourceId: 'demo', text: 'ab', limit: 5 }],
    ['a mask that is not a boolean', { sourceId: 'demo', text: 'ab', mask: 'true' }],
    ['no text', { sourceId: 'demo' }],
    ['no source', { text: 'ab' }],
  ])('answers INVALID_REQUEST for %s, with no read and no audit event', async (_name, body) => {
    const { app, executor, events } = await started();
    const response = await post(app, body);
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({ code: 'INVALID_REQUEST', traceId: expect.any(String) });
    expect(executor.calls).toEqual([]);
    expect(events).toEqual([]);
    await app.close();
  });

  it('answers INVALID_REQUEST for no body and for a query parameter', async () => {
    const { app, executor } = await started();
    expect((await app.inject({ method: 'POST', url: '/v1/search/entities' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/v1/search/entities?limit=5', payload: JSON.stringify({ sourceId: 'demo', text: 'ab' }), headers: { 'content-type': 'application/json' } })).statusCode).toBe(400);
    expect(executor.calls).toEqual([]);
    await app.close();
  });

  it('answers NOT_FOUND for a source that is not configured, with no read and one denied audit event that names no source', async () => {
    const { app, executor, events } = await started();
    const response = await post(app, { sourceId: 'nope', text: 'ab' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
    expect(executor.calls).toEqual([]);
    expect(events).toEqual([expect.objectContaining({ action: 'entity.search', result: 'denied' })]);
    expect(events[0]).not.toHaveProperty('sourceId');
    await app.close();
  });

  it('searches a text of one character, which a stable ID can be', async () => {
    const { app, executor } = await started([widget(1)]);
    const response = await post(app, { sourceId: 'demo', text: 'a' });
    expect(response.statusCode).toBe(200);
    expect(searchCalls(executor)).toHaveLength(1);
    await app.close();
  });
});

describe('POST /v1/search/entities answers a search', () => {
  it('answers 200 with the one entity, an exact count of 1 and one audited read through the gate', async () => {
    const { app, executor, events } = await started([widget(1, { status: 'open' })]);
    const response = await post(app, { sourceId: 'demo', text: 'W-001' });
    expect(response.statusCode).toBe(200);
    const result = searchResultSchema.parse(response.json());
    expect(result.sourceId).toBe('demo');
    expect(result.exact.map((node) => node.ref)).toEqual([{ sourceId: 'demo', entityType: 'widget', stableId: 'W-001' }]);
    expect(result.counts.exact).toMatchObject({ value: 1, quality: 'exact' });
    expect(result.cap).toBe(SEARCH_GROUP_CAP);
    expect(result.searchable).toBe(true);
    expect(result.disabledTypes).toEqual([]);
    expect(result.dropped).toEqual({ 'not-mapped': 0, 'ambiguous-type': 0, 'no-stable-id': 0 });
    expect(result.warnings).toEqual([]);
    expect(Number.isInteger(result.elapsedMs) && result.elapsedMs >= 0).toBe(true);
    expect(searchCalls(executor)).toHaveLength(1);
    expect(executor.calls.map((call) => call.templateId)).toEqual(['schema-indexes', 'entity-search', 'search-facets']);
    expect(searchCalls(executor)[0]).toMatchObject({ accessMode: 'READ', rowLimit: SEARCH_GROUP_CAP + 1 });
    expect(events.filter((event) => event.action === 'entity.search')).toEqual([expect.objectContaining({ result: 'success', sourceId: 'demo' })]);
    await app.close();
  });

  it('searches every search property of every type in one statement', async () => {
    const { app, executor } = await started();
    await post(app, { sourceId: 'demo', text: 'W-001' });
    const [call] = searchCalls(executor);
    expect(call?.cypher.match(/MATCH/g)).toHaveLength(3);
    expect(call?.cypher).toContain('MATCH (n:`Widget`) WHERE n.`ownerName` IN [$text, $textInteger] RETURN n LIMIT $limit + 1');
    expect(call?.cypher).toContain('MATCH (n:`Gadget`) WHERE n.`gadgetId` IN [$text, $textInteger] RETURN n LIMIT $limit + 1');
    expect(call?.parameters).toMatchObject({ text: 'W-001', textInteger: null, limit: SEARCH_GROUP_CAP });
    await app.close();
  });

  it('answers 200 with no hit and an exact count of 0 for a text no entity has', async () => {
    const { app } = await started([]);
    const response = await post(app, { sourceId: 'demo', text: 'nothing' });
    expect(response.statusCode).toBe(200);
    const result = searchResultSchema.parse(response.json());
    expect(result.exact).toEqual([]);
    expect(result.counts.exact).toMatchObject({ value: 0, quality: 'exact' });
    await app.close();
  });

  it.each([
    [24, 24, 'exact'],
    [25, 25, 'exact'],
    [26, 25, 'lowerBound'],
  ])('shows %i matches as %i hits and an %s count', async (matches, shown, quality) => {
    const { app } = await started(widgets(matches));
    const result = searchResultSchema.parse((await post(app, { sourceId: 'demo', text: 'W' + '-' })).json());
    expect(result.exact).toHaveLength(shown);
    expect(result.counts.exact).toMatchObject({ value: shown, quality });
    await app.close();
  });

  it.each([
    [10, 10, 'exact'],
    [11, 10, 'lowerBound'],
    [9, 9, 'exact'],
  ])('shows %i matches as %i hits and an %s count for a source whose max_page is 10, and echoes the cap', async (matches, shown, quality) => {
    const { app, executor } = await started(widgets(matches), mappingOf({ budgets: { max_page: 10, default_page: 10 } }));
    const result = searchResultSchema.parse((await post(app, { sourceId: 'demo', text: 'W-' })).json());
    expect(result.cap).toBe(10);
    expect(result.exact).toHaveLength(shown);
    expect(result.counts.exact).toMatchObject({ value: shown, quality });
    expect(searchCalls(executor)[0]).toMatchObject({ rowLimit: 11 });
    await app.close();
  });

  it('orders the hits by the mapping order of entity types and then by stable ID text, the same for the same hits', async () => {
    const mixed = [plainNode(['Gadget'], { gadgetId: 'GD-2' }, '4:g:1'), widget(3), plainNode(['Gadget'], { gadgetId: 'GD-1' }, '4:g:2'), widget(1), widget(2)];
    const first = await started(mixed);
    const reversed = await started([...mixed].reverse());
    const expected = ['widget W-001', 'widget W-002', 'widget W-003', 'gadget GD-1', 'gadget GD-2'];
    for (const parts of [first, reversed]) {
      const result = searchResultSchema.parse((await post(parts.app, { sourceId: 'demo', text: 'zz' })).json());
      expect(result.exact.map((node) => `${node.ref.entityType} ${node.ref.stableId}`)).toEqual(expected);
      await parts.app.close();
    }
  });
});

describe('what a search reports when normalization leaves rows out or merges them', () => {
  const model = normalizeModelOf(mapping.sources[0] ?? (() => { throw new Error('the mapping has no source'); })());
  const missing = (index: number) => plainNode(['Widget'], { status: 'open' }, `4:s:${index}`);
  const ambiguous = (index: number) => plainNode(['Widget', 'Gadget'], { widgetId: `A-${index}`, gadgetId: `A-${index}` }, `4:s:${index}`);
  const twin = (index: number, of: number) => plainNode(['Widget'], { widgetId: `W-${String(of).padStart(3, '0')}`, status: 'twin' }, `4:s:${index}`);
  const builders = [
    { name: 'a row with no stable ID', build: (index: number) => missing(index) },
    { name: 'a row of an ambiguous type', build: (index: number) => ambiguous(index) },
    { name: 'two nodes of one reference', build: (index: number, neighbour: number) => twin(index, neighbour) },
  ];
  const cases = builders.flatMap(({ name, build }) => [26, 25].flatMap((total) => [1, 25, 26].filter((position) => position <= total).map((position) => ({ name, build, total, position }))));

  it.each(cases)('holds only the hits that survive with $name at row $position of the $total rows read', async ({ build, total, position }) => {
    const rows = widgets(total).map((row, index) => (index + 1 === position ? build(index + 1, position === 1 ? 2 : position - 1) : row));
    const { app } = await started(rows);
    const result = searchResultSchema.parse((await post(app, { sourceId: 'demo', text: 'W-' })).json());
    const shown = normalizeRows({ sourceId: 'demo', hasMore: false, model }, rows.slice(0, SEARCH_GROUP_CAP).map((row) => ({ n: row })));
    expect(result.exact.map((node) => node.ref.stableId).sort()).toEqual(shown.nodes.map((node) => node.ref.stableId).sort());
    expect(result.dropped).toMatchObject(shown.dropped);
    expect(result.warnings).toEqual(shown.warnings);
    expect(result.counts.exact).toMatchObject({ value: shown.nodes.length, quality: total > SEARCH_GROUP_CAP ? 'lowerBound' : 'exact' });
    for (const node of result.exact) expect(node.qualityFlags).toEqual(shown.nodes.find((candidate) => candidate.ref.stableId === node.ref.stableId)?.qualityFlags);
    await app.close();
  });

  it('leaves out the row the gate cuts as the overflow row, whatever it is, and still says there is more', async () => {
    const rows = widgets(25).concat([missing(26)]);
    const { app } = await started(rows);
    const result = searchResultSchema.parse((await post(app, { sourceId: 'demo', text: 'W-' })).json());
    expect(result.exact).toHaveLength(25);
    expect(result.dropped['no-stable-id']).toBe(0);
    expect(result.counts.exact).toMatchObject({ value: 25, quality: 'lowerBound' });
    await app.close();
  });

  it('counts a read that overflowed and lost rows as a lower bound of the hits it holds', async () => {
    const rows = widgets(26).map((row, index) => (index === 0 ? missing(1) : row));
    const { app } = await started(rows);
    const result = searchResultSchema.parse((await post(app, { sourceId: 'demo', text: 'W-' })).json());
    expect(result.exact).toHaveLength(24);
    expect(result.counts.exact).toMatchObject({ value: 24, quality: 'lowerBound' });
    expect(result.warnings).toEqual(['1 row was left out because they have no usable stable ID.']);
    await app.close();
  });
});

describe('what a search keeps out of logs and errors', () => {
  const NEEDLE = 'needle-text-7731';

  it('writes the typed text to no log line and no audit event, on success and on failure', async () => {
    const ok = await started([widget(1)]);
    await post(ok.app, { sourceId: 'demo', text: NEEDLE });
    const failing = await started([], mapping, () => Promise.resolve({ status: 'timeout' }));
    const failed = await post(failing.app, { sourceId: 'demo', text: NEEDLE });
    expect(failed.statusCode).toBe(504);
    for (const parts of [ok, failing]) {
      expect(parts.lines.join('\n')).not.toContain(NEEDLE);
      expect(JSON.stringify(parts.events)).not.toContain(NEEDLE);
    }
    expect(failed.body).not.toContain(NEEDLE);
    expect(failed.json().error.traceId).toEqual(expect.any(String));
    await ok.app.close();
    await failing.app.close();
  });

  it('carries the trace ID in every error response', async () => {
    const { app } = await started();
    for (const body of [{ sourceId: 'demo', text: '' }, { sourceId: 'nope', text: 'ab' }]) {
      expect((await post(app, body)).json().error.traceId).toEqual(expect.any(String));
    }
    await app.close();
  });
});
