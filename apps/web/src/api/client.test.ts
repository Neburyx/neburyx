import { describe, expect, it } from 'vitest';
import { ERROR_TABLE, SOURCE_UNAVAILABLE_ENTRIES, SOURCE_UNAVAILABLE_REASONS } from '@neburyx/contracts';
import { createApiClient, type Fetcher } from './client.js';

const ME = {
  principal: { id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', displayName: 'Local user', role: 'administrator' },
  edition: 'community',
  identityMode: 'none',
  sources: [{ sourceId: 'source-a', viewSensitive: true, synthetic: true }],
};

function respondWith(body: unknown): Fetcher {
  return async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('the API client, reading the principal', () => {
  it('returns the parsed answer, asking for /v1/me', async () => {
    const asked: string[] = [];
    const client = createApiClient(async (input) => {
      asked.push(input);
      return new Response(JSON.stringify(ME));
    });
    const result = await client.getMe();
    expect(result).toEqual({ ok: true, value: ME });
    expect(asked).toEqual(['/v1/me']);
  });

  it('gives a network failure, and no value, when the request cannot be made', async () => {
    const client = createApiClient(async () => {
      throw new TypeError('failed to fetch');
    });
    expect(await client.getMe()).toEqual({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } });
  });

  it('gives a schema mismatch, and no partial value, for an answer that is not a principal', async () => {
    const client = createApiClient(respondWith({ principal: { displayName: 'x' } }));
    expect(await client.getMe()).toEqual({ ok: false, failure: { code: 'SCHEMA_MISMATCH' } });
  });

  it('treats a gateway status, or an error status with no body (what the dev proxy sends when the API is down), as the API being unreachable', async () => {
    for (const [status, body] of [[502, 'bad gateway'], [503, ''], [504, '{}'], [500, '']] as const) {
      const client = createApiClient(async () => new Response(body, { status }));
      expect(await client.getMe()).toEqual({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } });
    }
  });

  it('gives an unreadable-response failure for a body that is not JSON', async () => {
    const client = createApiClient(async () => new Response('<html>'));
    expect(await client.getMe()).toEqual({ ok: false, failure: { code: 'UNREADABLE_RESPONSE' } });
  });
});

describe('the API client, reading an error body', () => {
  const body = (code: 'QUERY_BUDGET_EXCEEDED' | 'SOURCE_UNAVAILABLE' | 'RATE_LIMITED' | 'QUERY_TIMEOUT', extra: Record<string, unknown> = {}) => ({
    error: { code, message: ERROR_TABLE[code].message, retryable: ERROR_TABLE[code].retryable, traceId: 'trace-1', ...(code === 'SOURCE_UNAVAILABLE' ? { details: { reason: 'unreachable' } } : {}), ...extra },
  });
  const failWith = (status: number, payload: unknown): Fetcher => async () => new Response(JSON.stringify(payload), { status });

  it('returns the code, message, retryable flag, trace ID and the allowed typed details', async () => {
    const client = createApiClient(failWith(400, body('QUERY_BUDGET_EXCEEDED', { details: { maxPage: 100 } })));
    const result = await client.getMe();
    expect(result).toEqual({ ok: false, failure: { code: 'QUERY_BUDGET_EXCEEDED', message: ERROR_TABLE.QUERY_BUDGET_EXCEEDED.message, retryable: ERROR_TABLE.QUERY_BUDGET_EXCEEDED.retryable, traceId: 'trace-1', details: { maxPage: 100 } } });
  });

  it.each(SOURCE_UNAVAILABLE_REASONS)('returns an unavailable source with the reason %s, its sentence and its retry flag', async (reason) => {
    const { message, retryable } = SOURCE_UNAVAILABLE_ENTRIES[reason];
    const result = await createApiClient(failWith(503, body('SOURCE_UNAVAILABLE', { message, retryable, details: { reason } }))).getMe();
    expect(result).toEqual({ ok: false, failure: { code: 'SOURCE_UNAVAILABLE', message, retryable, traceId: 'trace-1', details: { reason } } });
  });

  it.each(['SOURCE_UNAVAILABLE', 'QUERY_TIMEOUT', 'RATE_LIMITED'] as const)('returns %s, not an unreachable API, at the status the contract gives it (also 503 and 504)', async (code) => {
    const result = await createApiClient(failWith(ERROR_TABLE[code].status, body(code))).getMe();
    expect(result).toMatchObject({ ok: false, failure: { code, traceId: 'trace-1' } });
    expect(result.ok).toBe(false);
  });

  it.each([
    ['an unknown code', { error: { code: 'MADE_UP', message: 'x', retryable: false, traceId: 't' } }],
    ['a field its code does not allow', body('SOURCE_UNAVAILABLE', { extra: 1 })],
    ['details that belong to another code', body('SOURCE_UNAVAILABLE', { details: { maxPage: 3 } })],
    ['an unavailable source that gives no reason', body('SOURCE_UNAVAILABLE', { details: undefined })],
    ['an unavailable source whose sentence is not that of its reason', body('SOURCE_UNAVAILABLE', { details: { reason: 'index-failed' } })],
    ['an unavailable source whose retry flag is not that of its reason', body('SOURCE_UNAVAILABLE', { message: SOURCE_UNAVAILABLE_ENTRIES['index-failed'].message, retryable: true, details: { reason: 'index-failed' } })],
    ['a message that is not the code\'s message', body('RATE_LIMITED', { message: 'something else' })],
    ['a body of the wrong type', ['error']],
    ['no error key', { code: 'SOURCE_UNAVAILABLE' }],
  ])('returns a schema mismatch, never a partial error, for %s', async (_name, payload) => {
    expect(await createApiClient(failWith(400, payload)).getMe()).toEqual({ ok: false, failure: { code: 'SCHEMA_MISMATCH' } });
  });

  it('gives ABORTED, and no value, when the transport answers after the caller aborted', async () => {
    const controller = new AbortController();
    const late: Fetcher = async () => {
      controller.abort();
      return new Response(JSON.stringify(ME));
    };
    expect(await createApiClient(late).getMe(controller.signal)).toEqual({ ok: false, failure: { code: 'ABORTED' } });
  });

  it.each([400, 502, 503, 504])('reads an invalid error envelope as a schema mismatch at %i too, never as an unreachable API', async (status) => {
    const unknownCode = { error: { code: 'MADE_UP', message: 'x', retryable: false, traceId: 't' } };
    expect(await createApiClient(failWith(status, unknownCode)).getMe()).toEqual({ ok: false, failure: { code: 'SCHEMA_MISMATCH' } });
    expect(await createApiClient(failWith(status, body('SOURCE_UNAVAILABLE', { extra: 1 }))).getMe()).toEqual({ ok: false, failure: { code: 'SCHEMA_MISMATCH' } });
  });

  it('never repeats the response body in a failure', async () => {
    const result = await createApiClient(async () => new Response('secret-token-123 <html>', { status: 200 })).getMe();
    expect(JSON.stringify(result)).not.toContain('secret-token-123');
    expect(result).toEqual({ ok: false, failure: { code: 'UNREADABLE_RESPONSE' } });
  });

  it('gives ABORTED when the caller aborts before the request and when it aborts while the answer is awaited, and never a value', async () => {
    const before = new AbortController();
    before.abort();
    let asked = 0;
    const counting: Fetcher = async () => { asked += 1; return new Response(JSON.stringify(ME)); };
    expect(await createApiClient(counting).getMe(before.signal)).toEqual({ ok: false, failure: { code: 'ABORTED' } });
    expect(asked).toBe(0);

    const during = new AbortController();
    const hanging: Fetcher = (_input, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    const pending = createApiClient(hanging).getMe(during.signal);
    during.abort();
    expect(await pending).toEqual({ ok: false, failure: { code: 'ABORTED' } });
  });
});

describe('the API client, reading sources and a profile', () => {
  it('asks for /v1/sources and for a profile by the source id, encoded in the path', async () => {
    const asked: string[] = [];
    const client = createApiClient(async (input) => {
      asked.push(input);
      return new Response(JSON.stringify({}), { status: 200 });
    });
    await client.getSources();
    await client.getProfile('a b/c');
    expect(asked).toEqual(['/v1/sources', '/v1/sources/a%20b%2Fc/profile']);
  });

  it('gives a schema mismatch, never a partial value, for a list or a profile that does not match its contract', async () => {
    const client = createApiClient(async () => new Response(JSON.stringify({ items: [{ id: 1 }], nextCursor: null })));
    expect(await client.getSources()).toEqual({ ok: false, failure: { code: 'SCHEMA_MISMATCH' } });
    expect(await client.getProfile('a')).toEqual({ ok: false, failure: { code: 'SCHEMA_MISMATCH' } });
  });
});

describe('the API client, testing a source', () => {
  const report = {
    schemaVersion: 1,
    sourceId: 'source-a',
    checkedAt: '2026-11-02T10:00:00.000Z',
    outcome: 'pass',
    state: 'connected',
    stateReason: null,
    server: { product: 'Neo4j Kernel', version: '5.26.32', edition: 'community' },
    versionSupported: true,
    operations: [],
    readOnlyCheck: 'privileges-inspected',
    loginCanWrite: false,
    mappingChecks: { status: 'pass', findings: [] },
    degreeChecks: { status: 'not-run', foundOn: null, types: [], warnings: [] },
    mappingSummary: { entityTypes: 1, relationshipTypes: 1, derivedRules: 0 },
  };

  it('posts to the test path of the source with its id encoded, no body and no query, and returns the report', async () => {
    const calls: Array<{ readonly input: string; readonly init: unknown }> = [];
    const client = createApiClient(async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ ...report, sourceId: 'a b/c' }));
    });
    const result = await client.testSource('a b/c');
    expect(result.ok).toBe(true);
    expect(calls).toEqual([{ input: '/v1/sources/a%20b%2Fc/test', init: { method: 'POST' } }]);
    expect(calls[0]?.input).not.toContain('?');
  });

  it('gives a schema mismatch for an answer that is not a report, and for a report naming another source', async () => {
    expect(await createApiClient(respondWith({ sourceId: 'source-a' })).testSource('source-a')).toEqual({ ok: false, failure: { code: 'SCHEMA_MISMATCH' } });
    expect(await createApiClient(respondWith({ ...report, sourceId: 'source-b' })).testSource('source-a')).toEqual({ ok: false, failure: { code: 'SCHEMA_MISMATCH' } });
  });

  it('keeps the code and trace ID of an error the route answers with, including a busy source', async () => {
    const body = { error: { code: 'SOURCE_BUSY', message: ERROR_TABLE.SOURCE_BUSY.message, retryable: ERROR_TABLE.SOURCE_BUSY.retryable, traceId: 'trace-9' } };
    const result = await createApiClient(async () => new Response(JSON.stringify(body), { status: 503 })).testSource('source-a');
    expect(result).toMatchObject({ ok: false, failure: { code: 'SOURCE_BUSY', traceId: 'trace-9' } });
  });

  it('gives a network failure when the request cannot be made, and ABORTED after an abort', async () => {
    const down = createApiClient(async () => {
      throw new TypeError('failed to fetch');
    });
    expect(await down.testSource('source-a')).toEqual({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } });
    const controller = new AbortController();
    controller.abort();
    expect(await createApiClient(respondWith(report)).testSource('source-a', controller.signal)).toEqual({ ok: false, failure: { code: 'ABORTED' } });
  });
});

describe('the API client, searching a source', () => {
  const node = (sourceId: string) => ({ ref: { sourceId, entityType: 'kind-a', stableId: 'AC-1' }, display: { title: 'AC-1', type: 'kind-a' }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } });
  const answer = (sourceId: string, hits: readonly ReturnType<typeof node>[]) => ({
    sourceId,
    exact: hits,
    exactMatches: hits.map((entity) => ({ ref: entity.ref, matchedProperties: [] })),
    cap: 25,
    searchable: true,
    counts: { exact: { value: hits.length, quality: 'exact', scope: 'search:exact' } },
    disabledTypes: [],
    related: { hits: [], count: { value: 0, quality: 'exact', scope: 'search:related' }, searchable: true, disabledTypes: [] },
    evidence: { hits: [], count: { value: 0, quality: 'exact', scope: 'search:evidence' }, searchable: false, disabledRelationshipTypes: [] },
    failures: [],
    dropped: { 'not-mapped': 0, 'ambiguous-type': 0, 'no-stable-id': 0 },
    warnings: [],
    elapsedMs: 12,
    facets: { searchable: false },
    filters: { entityTypes: [], matchModes: [] },
  });

  const typeaheadAnswer = (...args: Parameters<typeof answer>) => {
    const { facets: _facets, filters: _filters, ...rest } = answer(...args);
    return rest;
  };

  it('posts the request as JSON to /v1/search/entities and returns the parsed answer', async () => {
    const seen: { input: string; init?: { method?: string; body?: string; headers?: Readonly<Record<string, string>> } }[] = [];
    const client = createApiClient(async (input, init) => {
      seen.push({ input, ...(init === undefined ? {} : { init }) });
      return new Response(JSON.stringify(answer('demo', [node('demo')])));
    });
    const result = await client.searchEntities({ sourceId: 'demo', text: 'AC-1', mask: true });
    expect(result).toMatchObject({ ok: true, value: { sourceId: 'demo' } });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.input).toBe('/v1/search/entities');
    expect(seen[0]?.init).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/json' } });
    expect(JSON.parse(seen[0]?.init?.body ?? '{}')).toEqual({ sourceId: 'demo', text: 'AC-1', mask: true });
  });

  it('refuses an answer for another source, and an answer with a hit of another source', async () => {
    expect(await createApiClient(respondWith(answer('other', []))).searchEntities({ sourceId: 'demo', text: 'AC-1' })).toEqual({ ok: false, failure: { code: 'SCHEMA_MISMATCH' } });
    expect(await createApiClient(respondWith(answer('demo', [node('other')]))).searchEntities({ sourceId: 'demo', text: 'AC-1' })).toEqual({ ok: false, failure: { code: 'SCHEMA_MISMATCH' } });
  });

  it('sends the type-ahead flag, takes a startsWith group of the source asked, and refuses one with a hit of another source', async () => {
    const group = (hits: readonly object[]) => ({ nodes: hits, count: { value: hits.length, quality: 'exact', scope: 'search:startsWith' }, dropped: { 'not-mapped': 0, 'ambiguous-type': 0, 'no-stable-id': 0 }, warnings: [] });
    const seen: string[] = [];
    const client = createApiClient(async (_input, init) => {
      seen.push(init?.body ?? '');
      return new Response(JSON.stringify({ ...typeaheadAnswer('demo', []), startsWith: group([node('demo')]) }));
    });
    expect(await client.searchEntities({ sourceId: 'demo', text: 'AC', typeahead: true })).toMatchObject({ ok: true, value: { startsWith: { nodes: [{ ref: { sourceId: 'demo' } }] } } });
    expect(JSON.parse(seen[0] ?? '{}')).toEqual({ sourceId: 'demo', text: 'AC', typeahead: true });
    const foreign = respondWith({ ...typeaheadAnswer('demo', [node('demo')]), startsWith: group([node('other')]) });
    expect(await createApiClient(foreign).searchEntities({ sourceId: 'demo', text: 'AC', typeahead: true })).toEqual({ ok: false, failure: { code: 'SCHEMA_MISMATCH' } });
  });

  it('gives the error of the API as it came, with the timeout of a timed-out search', async () => {
    const body = { error: { code: 'QUERY_TIMEOUT', message: ERROR_TABLE.QUERY_TIMEOUT.message, retryable: true, traceId: 'tr-1', details: { timeoutMs: 5000 } } };
    const client = createApiClient(async () => new Response(JSON.stringify(body), { status: 504 }));
    expect(await client.searchEntities({ sourceId: 'demo', text: 'AC-1' })).toEqual({ ok: false, failure: body.error });
  });
});

const PREVIEW = {
  ref: { sourceId: 'demo', entityType: 'widget', stableId: 'W-1' },
  total: { value: 3, quality: 'exact', scope: 'degree:total:mapped-relationship-ends' },
  byType: [{ relationshipType: 'LINKS', direction: 'out', count: { value: 3, quality: 'exact', scope: 'degree:out:LINKS:mapped-relationship-ends' }, neighborTypes: ['gadget'] }],
  byNeighborType: [{ entityType: 'gadget', count: { value: 3, quality: 'exact', scope: 'degree:neighbor:gadget:mapped-relationship-ends' } }],
  warnings: [],
  pageSize: 25,
  heavyOpThreshold: 500,
};
const PREVIEW_REQUEST = { sourceId: 'demo', ref: { entityType: 'widget', stableId: 'W-1' } };

describe('the API client, previewing the degree of a node', () => {
  it('posts the request to the preview path and parses the answer', async () => {
    const seen: { input: string; init?: Parameters<Fetcher>[1] }[] = [];
    const client = createApiClient(async (input, init) => {
      seen.push({ input, ...(init === undefined ? {} : { init }) });
      return new Response(JSON.stringify(PREVIEW));
    });
    expect(await client.previewExpansion({ ...PREVIEW_REQUEST, mask: true })).toEqual({ ok: true, value: PREVIEW });
    expect(seen[0]?.input).toBe('/v1/graph/preview-expansion');
    expect(JSON.parse(seen[0]?.init?.body ?? '{}')).toEqual({ ...PREVIEW_REQUEST, mask: true });
  });

  it.each([
    ['an answer that does not parse', { ...PREVIEW, total: 3 }],
    ['an answer with no warning threshold', { ...PREVIEW, heavyOpThreshold: undefined }],
    ['a valid answer for another source', { ...PREVIEW, ref: { ...PREVIEW.ref, sourceId: 'other' } }],
    ['a valid answer for another node', { ...PREVIEW, ref: { ...PREVIEW.ref, stableId: 'W-2' } }],
    ['a valid answer for another entity type', { ...PREVIEW, ref: { ...PREVIEW.ref, entityType: 'gadget' } }],
  ])('refuses %s as a schema mismatch', async (_name, body) => {
    expect(await createApiClient(respondWith(body)).previewExpansion(PREVIEW_REQUEST)).toEqual({ ok: false, failure: { code: 'SCHEMA_MISMATCH' } });
  });

  it('gives the error of the API as it came', async () => {
    const body = { error: { code: 'NOT_FOUND', message: ERROR_TABLE.NOT_FOUND.message, retryable: false, traceId: 'tr-1' } };
    const client = createApiClient(async () => new Response(JSON.stringify(body), { status: 404 }));
    expect(await client.previewExpansion(PREVIEW_REQUEST)).toEqual({ ok: false, failure: body.error });
  });
});

describe('graphCoverage', () => {
  const REQUEST = { sourceId: 'demo', entities: [{ ref: { sourceId: 'demo', entityType: 'widget', stableId: 'W-1' }, loadedRelationships: 2, loadedQuality: 'exact' as const }] };
  const ANSWER = { notRetrieved: { value: 5, quality: 'exact', scope: 'not yet retrieved' }, uncounted: 0 };

  it('posts the loaded entities to /v1/graph/coverage and parses the count', async () => {
    const seen: { input: string; init?: { body?: string } }[] = [];
    const client = createApiClient(async (input, init) => {
      seen.push({ input: String(input), ...(init === undefined ? {} : { init: { body: String(init.body) } }) });
      return new Response(JSON.stringify(ANSWER));
    });
    expect(await client.graphCoverage(REQUEST)).toEqual({ ok: true, value: ANSWER });
    expect(seen[0]?.input).toBe('/v1/graph/coverage');
    expect(JSON.parse(seen[0]?.init?.body ?? '{}')).toEqual(REQUEST);
  });

  it('refuses an answer that does not parse as a schema mismatch, one without the entities not yet counted among them', async () => {
    expect(await createApiClient(respondWith({ notRetrieved: { value: 5, quality: 'unknown', scope: 'x' }, uncounted: 0 })).graphCoverage(REQUEST)).toEqual({ ok: false, failure: { code: 'SCHEMA_MISMATCH' } });
    expect(await createApiClient(respondWith({ notRetrieved: { value: 5, quality: 'exact', scope: 'x' } })).graphCoverage(REQUEST)).toEqual({ ok: false, failure: { code: 'SCHEMA_MISMATCH' } });
  });
});

const DERIVED_REF = { sourceId: 'demo', entityType: 'widget', stableId: 'W-1' };
const DERIVED_NODE = { ref: { ...DERIVED_REF, stableId: 'W-2' }, display: { title: 'W-2', type: 'widget' }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } };
const DERIVED_ANSWER = { ref: DERIVED_REF, results: [{ ruleId: 'shared', ruleVersion: 1, count: { value: 0, quality: 'exact', scope: 'derived:neighbors' }, nodes: [], edges: [], warnings: [] }] };

describe('the API client, asking for the rule-derived neighbors of a node', () => {
  it('posts the request to the derived neighbors path and parses the answer', async () => {
    const seen: { input: string; init?: Parameters<Fetcher>[1] }[] = [];
    const client = createApiClient(async (input, init) => {
      seen.push({ input, ...(init === undefined ? {} : { init }) });
      return new Response(JSON.stringify(DERIVED_ANSWER));
    });
    expect(await client.derivedNeighbors({ ...PREVIEW_REQUEST, mask: true })).toEqual({ ok: true, value: DERIVED_ANSWER });
    expect(seen[0]?.input).toBe('/v1/graph/derived-neighbors');
    expect(JSON.parse(seen[0]?.init?.body ?? '{}')).toEqual({ ...PREVIEW_REQUEST, mask: true });
  });

  it('accepts a result whose nodes are of the source asked', async () => {
    const body = { ...DERIVED_ANSWER, results: [{ ...DERIVED_ANSWER.results[0], nodes: [DERIVED_NODE] }] };
    expect(await createApiClient(respondWith(body)).derivedNeighbors(PREVIEW_REQUEST)).toEqual({ ok: true, value: body });
  });

  it.each([
    ['an answer that does not parse', { ...DERIVED_ANSWER, results: 3 }],
    ['a valid answer for another source', { ...DERIVED_ANSWER, ref: { ...DERIVED_REF, sourceId: 'other' } }],
    ['a valid answer for another node', { ...DERIVED_ANSWER, ref: { ...DERIVED_REF, stableId: 'W-9' } }],
    ['a result with a node of another source', { ...DERIVED_ANSWER, results: [{ ...DERIVED_ANSWER.results[0], nodes: [{ ...DERIVED_NODE, ref: { ...DERIVED_NODE.ref, sourceId: 'other' } }] }] }],
  ])('refuses %s as a schema mismatch', async (_name, body) => {
    expect(await createApiClient(respondWith(body)).derivedNeighbors(PREVIEW_REQUEST)).toEqual({ ok: false, failure: { code: 'SCHEMA_MISMATCH' } });
  });
});

describe('the API client, reading one stored edge', () => {
  const REF = { sourceId: 'source-a', type: 'MADE_FROM', from: 'widget', to: 'gadget', stableId: 'L-1' };
  const END = (stableId: string, entityType: string) => ({ ref: { sourceId: 'source-a', entityType, stableId }, title: stableId, type: entityType });
  const DETAIL = { ref: REF, type: 'MADE_FROM', semantics: 'stored', from: END('W-1', 'widget'), to: END('GT-1', 'gadget'), properties: [], qualityFlags: [], evidence: { status: 'not-available', code: 'EVIDENCE_NOT_AVAILABLE' } };

  it('asks for the one segment of the reference, with mask when asked, and returns the edge', async () => {
    const asked: string[] = [];
    const client = createApiClient(async (input) => {
      asked.push(input);
      return new Response(JSON.stringify(DETAIL));
    });
    expect(await client.getEdge(REF)).toEqual({ ok: true, value: DETAIL });
    await client.getEdge(REF, { mask: true });
    expect(asked[0]).toMatch(/^\/v1\/edges\/[A-Za-z0-9_-]+$/);
    expect(asked[1]).toBe(`${asked[0]}?mask=true`);
  });

  it('refuses an answer for another edge', async () => {
    const client = createApiClient(respondWith({ ...DETAIL, ref: { ...REF, stableId: 'L-2' } }));
    expect(await client.getEdge(REF)).toEqual({ ok: false, failure: { code: 'SCHEMA_MISMATCH' } });
  });

  it('refuses an answer that has a score or the wrong shape', async () => {
    expect(await createApiClient(respondWith({ ...DETAIL, confidence: 0.9 })).getEdge(REF)).toEqual({ ok: false, failure: { code: 'SCHEMA_MISMATCH' } });
    expect(await createApiClient(respondWith({ ...DETAIL, evidence: { status: 'available', records: [] } })).getEdge(REF)).toEqual({ ok: false, failure: { code: 'SCHEMA_MISMATCH' } });
  });

  it('gives the API error as it came, and no value', async () => {
    const client = createApiClient(async () => new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: ERROR_TABLE.NOT_FOUND.message, retryable: false, traceId: 'tr-1' } }), { status: 404 }));
    expect(await client.getEdge(REF)).toEqual({ ok: false, failure: { code: 'NOT_FOUND', message: ERROR_TABLE.NOT_FOUND.message, retryable: false, traceId: 'tr-1' } });
  });

  it('answers ABORTED without a request when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let asked = 0;
    const client = createApiClient(async () => {
      asked += 1;
      return new Response('{}');
    });
    expect(await client.getEdge(REF, undefined, controller.signal)).toEqual({ ok: false, failure: { code: 'ABORTED' } });
    expect(asked).toBe(0);
  });
});

describe('the API client, listing the templates of a source', () => {
  const list = { sourceId: 'a b/c', templates: [{ id: 'shared-attribute', version: '1', name: 'Shared attribute', description: 'd', paramsSchema: { type: 'object' } }], presets: [] };

  it('asks for /v1/templates with the source in the query, encoded, and returns the parsed answer', async () => {
    const asked: string[] = [];
    const client = createApiClient(async (input) => {
      asked.push(input);
      return new Response(JSON.stringify(list));
    });
    const result = await client.listTemplates('a b/c');
    expect(asked).toEqual(['/v1/templates?sourceId=a%20b%2Fc']);
    expect(result).toEqual({ ok: true, value: list });
  });

  it('gives a schema mismatch for an answer that is not a list, and for a list of another source', async () => {
    expect(await createApiClient(async () => new Response(JSON.stringify({ sourceId: 'a b/c' }))).listTemplates('a b/c')).toEqual({ ok: false, failure: { code: 'SCHEMA_MISMATCH' } });
    expect(await createApiClient(async () => new Response(JSON.stringify(list))).listTemplates('other')).toEqual({ ok: false, failure: { code: 'SCHEMA_MISMATCH' } });
  });

  it('keeps the code of an error the route answers with, gives a network failure, and ABORTED after an abort', async () => {
    const body = { error: { code: 'NOT_FOUND', message: ERROR_TABLE.NOT_FOUND.message, retryable: ERROR_TABLE.NOT_FOUND.retryable, traceId: 'trace-3' } };
    expect(await createApiClient(async () => new Response(JSON.stringify(body), { status: 404 })).listTemplates('a')).toMatchObject({ ok: false, failure: { code: 'NOT_FOUND', traceId: 'trace-3' } });
    const down = createApiClient(async () => {
      throw new TypeError('failed to fetch');
    });
    expect(await down.listTemplates('a')).toEqual({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } });
    const controller = new AbortController();
    controller.abort();
    expect(await createApiClient(async () => new Response(JSON.stringify(list))).listTemplates('a b/c', controller.signal)).toEqual({ ok: false, failure: { code: 'ABORTED' } });
  });
});
