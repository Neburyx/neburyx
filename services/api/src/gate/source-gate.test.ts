import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { auditing, integerTemplate, markerTemplate, mappingOf, nodesTemplate, sourceWith } from '../testing/gate-fixtures.js';
import { gateRequest, harness, LOCAL_PRINCIPAL, rowsOf, recordingObserver, TestExecutor } from '../testing/gate.js';
import { testSourceGate } from '../testing/source-gate.js';
import { entityRows, plainNode } from '../testing/entity-fixtures.js';
import { rangeIndex, schemaAnswer } from '../testing/search-fixtures.js';
import { createTemplateCatalog } from './catalog.js';
import { isSystemId, SYSTEM_ID } from './system-principal.js';
import { connectivityTemplate } from './templates/connectivity.js';

const mapping = mappingOf(sourceWith('alpha'));
const COMPONENT = { name: 'Neo4j Kernel', version: '5.26.0', edition: 'community' };

function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a refusal');
    },
    (error: unknown) => error,
  );
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error = await rejection(promise);
  return error instanceof AppError ? error.code : 'not an AppError';
}

const connectivity = (overrides = {}) => gateRequest({ sourceId: 'alpha', templateId: 'connectivity', params: {}, limit: 1, ...overrides });

describe('the connectivity template through the gate', () => {
  it('reaches the executor with its fixed Cypher in a read call and returns one item with the product, version and edition', async () => {
    const executor = new TestExecutor(() => Promise.resolve({ status: 'rows', rows: [COMPONENT] }));
    const { gate } = testSourceGate(mapping, { executor });
    const page = await gate.run(connectivity());
    expect(page).toEqual({ items: [{ product: 'Neo4j Kernel', version: '5.26.0', edition: 'community' }], hasMore: false });
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]).toMatchObject({ sourceId: 'alpha', templateId: 'connectivity', cypher: connectivityTemplate.cypher, accessMode: 'READ', rowLimit: 2 });
  });

  it.each([
    ['a template id the catalog does not hold', { templateId: 'absent' }],
    ['any key', { params: { a: 1 } }],
    ['params that are not an object', { params: 'x' }],
    ['params that are a list', { params: [] }],
    ['params that are null', { params: null }],
  ])('answers INVALID_REQUEST for %s, and the executor is not called', async (_name, overrides) => {
    const { gate, executor } = testSourceGate(mapping);
    expect(await codeOf(gate.run(connectivity(overrides)))).toBe('INVALID_REQUEST');
    expect(executor.calls).toEqual([]);
  });

  it('answers INVALID_REQUEST for a template the catalog disables for the source, and not for another source', async () => {
    const two = mappingOf(sourceWith('alpha'), sourceWith('beta'));
    const catalog = createTemplateCatalog({ templates: [connectivityTemplate], isEnabled: (_templateId, sourceId) => sourceId !== 'alpha' });
    const { gate, executor } = testSourceGate(two, { catalog });
    expect(await codeOf(gate.run(connectivity()))).toBe('INVALID_REQUEST');
    expect(executor.calls).toEqual([]);
    await gate.run(connectivity({ sourceId: 'beta' }));
    expect(executor.calls).toHaveLength(1);
  });

  it.each([
    [{ status: 'timeout' }, 'QUERY_TIMEOUT'],
    [{ status: 'unavailable', reason: 'unreachable' }, 'SOURCE_UNAVAILABLE'],
  ] as const)('answers %j from the executor with %s', async (outcome, code) => {
    const { gate } = testSourceGate(mapping, { executor: new TestExecutor(() => Promise.resolve(outcome)) });
    expect(await codeOf(gate.run(connectivity()))).toBe(code);
  });
});

describe('per-source budgets', () => {
  const two = mappingOf(sourceWith('small', { budgets: { timeout_ms: 1500, max_page: 20 } }), sourceWith('large', { budgets: { timeout_ms: 7000, max_page: 40 } }), sourceWith('plain'), sourceWith('ceiling', { budgets: { timeout_ms: 10_000, max_page: 50 } }));
  const catalog = createTemplateCatalog({ templates: [connectivityTemplate, nodesTemplate] });
  const nodes = (sourceId: string, limit: number) => gateRequest({ sourceId, templateId: 'nodes-read', params: { kind: 'person' }, limit });

  it('carries each source its own timeout to the executor', async () => {
    const { gate, executor } = testSourceGate(two, { catalog });
    for (const sourceId of ['small', 'large', 'plain', 'ceiling']) await gate.run(nodes(sourceId, 10));
    expect(executor.calls.map((call) => [call.sourceId, call.timeoutMs])).toEqual([['small', 1500], ['large', 7000], ['plain', 5000], ['ceiling', 10_000]]);
  });

  it('lets a limit between the two max_page values pass for the larger and refuses it for the smaller, with details.maxPage', async () => {
    const { gate, executor } = testSourceGate(two, { catalog });
    await gate.run(nodes('large', 30));
    const error = await rejection(gate.run(nodes('small', 30)));
    expect(error).toMatchObject({ code: 'QUERY_BUDGET_EXCEEDED', details: { maxPage: 20 } });
    expect(executor.calls.map((call) => call.sourceId)).toEqual(['large']);
  });

  it('uses the mapping defaults (50) for a source with no budgets block and the ceiling (50) for one at the ceilings: 50 passes, 51 is refused', async () => {
    const { gate, executor } = testSourceGate(two, { catalog });
    for (const sourceId of ['plain', 'ceiling']) {
      await gate.run(nodes(sourceId, 50));
      expect(await rejection(gate.run(nodes(sourceId, 51)))).toMatchObject({ code: 'QUERY_BUDGET_EXCEEDED', details: { maxPage: 50 } });
    }
    expect(executor.calls).toHaveLength(2);
  });

  it('answers NOT_FOUND for an unknown source, audited refused, and the executor is not called', async () => {
    const recording = auditing();
    const { gate, executor } = testSourceGate(two, { catalog, seams: recording.seams });
    expect(await codeOf(gate.run(nodes('absent', 5)))).toBe('NOT_FOUND');
    expect(recording.events.map((event) => event.result)).toEqual(['refused']);
    expect(executor.calls).toEqual([]);
  });
});

describe('allowlists and quoted interpolation', () => {
  const two = mappingOf(sourceWith('alpha'), sourceWith('beta', { entities: [{ type: 'widget', label: 'Widget', stable_id: 'id' }], relationships: [] }));
  const catalog = createTemplateCatalog({ templates: [markerTemplate, nodesTemplate] });
  const request = (params: unknown, sourceId = 'alpha') => gateRequest({ sourceId, templateId: 'marker-read', params, limit: 5 });

  it('writes the label and the relationship type from the mapping, backtick-quoted, into the marked places, and leaves only the other parameters', async () => {
    const { gate, executor } = testSourceGate(two, { catalog });
    await gate.run(request({ kind: 'order_line', via: 'HAS LINE' }));
    expect(executor.calls[0]?.cypher).toBe('MATCH (n:`Order Line`)-[r:`HAS LINE`]->(m) RETURN n.id AS id LIMIT $limit + 1');
    expect(executor.calls[0]?.parameters).toEqual({ limit: 5, cursor: null });
  });

  it('lists several relationship types quoted and separated by |', async () => {
    const { gate, executor } = testSourceGate(two, { catalog });
    await gate.run(request({ kind: 'person', via: ['KNOWS', 'HAS LINE'] }));
    expect(executor.calls[0]?.cypher).toContain('[r:`KNOWS`|`HAS LINE`]');
  });

  it.each([
    ['an entity type that is not mapped', { kind: 'unmapped', via: 'KNOWS' }],
    ['an entity type of another source', { kind: 'widget', via: 'KNOWS' }],
    ['a label instead of a type', { kind: 'Person', via: 'KNOWS' }],
    ['text that looks like query text', { kind: 'person` ) DETACH DELETE n //', via: 'KNOWS' }],
    ['a relationship type that is not mapped', { kind: 'person', via: 'LIKES' }],
    ['a list for an entity marker', { kind: ['person'], via: 'KNOWS' }],
    ['a number for an entity marker', { kind: 5, via: 'KNOWS' }],
    ['an object for an entity marker', { kind: { a: 1 }, via: 'KNOWS' }],
    ['an empty list of relationship types', { kind: 'person', via: [] }],
    ['a repeated relationship type', { kind: 'person', via: ['KNOWS', 'KNOWS'] }],
    ['a list with a type outside the allowlist', { kind: 'person', via: ['KNOWS', 'LIKES'] }],
    ['a list with a member that is not text', { kind: 'person', via: ['KNOWS', 5] }],
    ['an object for a relationship marker', { kind: 'person', via: { a: 1 } }],
  ])('answers INVALID_REQUEST for %s, from the validate stage, and the executor is not called', async (_name, params) => {
    const observer = recordingObserver();
    const { gate, executor } = testSourceGate(two, { catalog, observer });
    expect(await codeOf(gate.run(request(params)))).toBe('INVALID_REQUEST');
    expect(executor.calls).toEqual([]);
    expect(observer.events.filter((event) => event.outcome === 'failed').map((event) => event.stage)).toEqual(['validate']);
  });

  it('answers INVALID_REQUEST when the strict schema fails, and for an element reference that names this source with an unmapped type', async () => {
    const { gate, executor } = testSourceGate(two, { catalog });
    expect(await codeOf(gate.run(request({ kind: 'person', via: 'KNOWS', extra: 1 })))).toBe('INVALID_REQUEST');
    expect(await codeOf(gate.run(request({ kind: 'person', via: 'KNOWS', ref: { sourceId: 'alpha', entityType: 'unmapped', stableId: '1' } })))).toBe('INVALID_REQUEST');
    expect(executor.calls).toEqual([]);
  });

  it('keeps SOURCE_MISMATCH for an element reference that names another source, whatever its entity type', async () => {
    const { gate, executor } = testSourceGate(two, { catalog });
    expect(await codeOf(gate.run(request({ kind: 'person', via: 'KNOWS', ref: { sourceId: 'beta', entityType: 'unmapped', stableId: '1' } })))).toBe('SOURCE_MISMATCH');
    expect(await codeOf(gate.run(request({ kind: 'person', via: 'KNOWS', ref: { sourceId: 'beta', entityType: 'person', stableId: '1' } })))).toBe('SOURCE_MISMATCH');
    expect(executor.calls).toEqual([]);
  });

  it('accepts an element reference that names this source with a mapped type', async () => {
    const { gate, executor } = testSourceGate(two, { catalog });
    await gate.run(request({ kind: 'person', via: 'KNOWS', ref: { sourceId: 'alpha', entityType: 'order_line', stableId: '1' } }));
    expect(executor.calls).toHaveLength(1);
  });
});

describe('a name that cannot be quoted', () => {
  const BAD = 'holds a backtick, a backslash or a control character';
  it.each([
    ['a backtick', 'Per`son', BAD],
    ['a backslash', 'Per\\son', BAD],
    ['a backslash before a backtick', 'Person\\`', BAD],
    ['a control character', 'Per\nson', BAD],
    ['only whitespace', '   ', 'is empty or only whitespace'],
  ])('in a label (%s) stops the gate being created, naming the source, the type and the problem', (_name, label, problem) => {
    const broken = mappingOf(sourceWith('alpha', { entities: [{ type: 'person', label, stable_id: 'id' }], relationships: [] }));
    const named = label.trim() === '' ? '(empty)' : 'named in the mapping';
    expect(() => testSourceGate(broken)).toThrow(`source alpha: the label of entity type person ${named} ${problem}`);
  });

  it('in a relationship type stops the gate being created, naming the source, the type and the problem', () => {
    const broken = mappingOf(sourceWith('alpha', { relationships: [{ type: 'KN`OWS', from: 'person', to: 'person' }] }));
    expect(() => testSourceGate(broken)).toThrow(`source alpha: the relationship type KN\`OWS named in the mapping ${BAD}`);
  });
});

describe('the page limit', () => {
  const catalog = createTemplateCatalog({ templates: [markerTemplate, nodesTemplate, integerTemplate] });

  it('reaches the executor beside the template parameters, for a marker template and for an integer template', async () => {
    const { gate, executor } = testSourceGate(mapping, { catalog });
    await gate.run(gateRequest({ sourceId: 'alpha', templateId: 'nodes-read', params: { kind: 'person' }, limit: 7 }));
    await gate.run(gateRequest({ sourceId: 'alpha', templateId: 'integer-read', params: { k: 3 }, limit: 9 }));
    expect(executor.calls.map((call) => call.parameters)).toEqual([{ limit: 7, cursor: null }, { k: 3, limit: 9 }]);
    expect(executor.calls[1]?.integerParameters).toEqual(['k']);
  });

  it('cannot be set or overridden by a request', async () => {
    const { gate, executor } = testSourceGate(mapping, { catalog });
    expect(await codeOf(gate.run(gateRequest({ sourceId: 'alpha', templateId: 'nodes-read', params: { kind: 'person', limit: 1000 }, limit: 7 })))).toBe('INVALID_REQUEST');
    expect(await codeOf(gate.run(gateRequest({ sourceId: 'alpha', templateId: 'integer-read', params: { k: 1, limit: 1000 }, limit: 7 })))).toBe('INVALID_REQUEST');
    expect(executor.calls).toEqual([]);
  });

  it('turns an extra row into hasMore on the page', async () => {
    const executor = new TestExecutor((call) => Promise.resolve(rowsOf(call.rowLimit)));
    const { gate } = testSourceGate(mapping, { catalog, executor });
    const page = await gate.run(gateRequest({ sourceId: 'alpha', templateId: 'nodes-read', params: { kind: 'person' }, limit: 4 }));
    expect(page.items).toHaveLength(4);
    expect(page.hasMore).toBe(true);
  });
});

describe('a name that cannot be quoted when the render step meets it', () => {
  it.each(['', 'a`b', 'a\\b', 'a\nb', '  '])('answers INTERNAL_ERROR from the validate stage for the label %j, audited failed, and the executor is not called', async (label) => {
    const recording = auditing();
    const catalog = createTemplateCatalog({ templates: [nodesTemplate] });
    const { gate, executor, observer } = harness({ catalog, seams: recording.seams, allowlistFor: () => ({ entityLabels: new Map([['person', label]]), relationshipTypes: new Set(), stableIds: new Map(), searchProperties: new Map(), referenceProperties: new Map(), evidenceRows: [], relationshipRows: [], properties: new Set() }) });
    expect(await codeOf(gate.run(gateRequest({ templateId: 'nodes-read', params: { kind: 'person' }, limit: 3 })))).toBe('INTERNAL_ERROR');
    expect(executor.calls).toEqual([]);
    expect(recording.events.map((event) => event.result)).toEqual(['failed']);
    expect(observer.events.filter((event) => event.outcome === 'failed').map((event) => event.stage)).toEqual(['validate']);
  });
});

describe('the audit event of a read', () => {
  it('carries the principal of the request and its role', async () => {
    const recording = auditing();
    const { gate } = testSourceGate(mapping, { seams: recording.seams, executor: new TestExecutor(() => Promise.resolve({ status: 'rows', rows: [COMPONENT] })) });
    await gate.run(connectivity());
    expect(recording.events[0]).toMatchObject({ actorId: LOCAL_PRINCIPAL.id, actorRole: LOCAL_PRINCIPAL.role, action: 'source.connectivity', result: 'success' });
    expect(isSystemId(LOCAL_PRINCIPAL.id)).toBe(false);
    expect(SYSTEM_ID).not.toBe(LOCAL_PRINCIPAL.id);
  });
});

describe('a source no check has reached, or whose check failed', () => {
  const person = (state: string) =>
    new TestExecutor((call) => Promise.resolve(call.templateId === 'schema-indexes' ? schemaAnswer([rangeIndex('Person', 'id', state, true)]) : entityRows(plainNode(['Person'], { id: 'P-1' }))));
  const load = gateRequest({ sourceId: 'alpha', templateId: 'entity-load', params: { entityType: 'person', stableId: 'P-1' }, limit: 1 });

  it('has its index snapshot read and its user reads guarded by it: the gate holds no verdict of the checks', async () => {
    const executor = person('ONLINE');
    const parts = testSourceGate(mapping, { executor });
    expect(await parts.indexes.read({ traceId: 'tr-unchecked', principal: LOCAL_PRINCIPAL, sourceId: 'alpha' })).toMatchObject({ sourceId: 'alpha' });
    expect((await parts.gate.run(load)).items).toHaveLength(1);
    expect(executor.calls.map((call) => call.templateId)).toEqual(['schema-indexes', 'schema-indexes', 'entity-load']);
  });

  it('refuses a read whose index is still building, with that reason and no data statement', async () => {
    const executor = person('POPULATING');
    const parts = testSourceGate(mapping, { executor });
    await expect(parts.gate.run(load)).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE', reason: 'index-building' });
    expect(executor.calls.map((call) => call.templateId)).toEqual(['schema-indexes']);
  });
});
