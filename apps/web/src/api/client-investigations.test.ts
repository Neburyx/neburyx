import { describe, expect, it } from 'vitest';
import { createApiClient, type FetchInit, type Fetcher } from './client.js';
import { INVESTIGATION_A, investigationOf, nodeOf, openedOf, readOf } from '../investigations/test-data.js';

interface Asked {
  readonly path: string;
  readonly init: FetchInit | undefined;
}

function answering(body: unknown, status = 200): { readonly fetcher: Fetcher; readonly asked: Asked[] } {
  const asked: Asked[] = [];
  return {
    asked,
    fetcher: async (path, init) => {
      asked.push({ path, init });
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    },
  };
}

const REF = { sourceId: 'source-a', entityType: 'kind-a', stableId: 'A-1' };

describe('getEntity', () => {
  it('asks for the three parts of the reference as encoded path segments and parses the node', async () => {
    const odd = { sourceId: 'source a', entityType: 'kind-a', stableId: 'a/b?c#d%e é' };
    const { fetcher, asked } = answering(nodeOf(odd.sourceId, odd.entityType, odd.stableId));
    const result = await createApiClient(fetcher).getEntity(odd);
    expect(result.ok).toBe(true);
    expect(asked[0]?.path).toBe('/v1/entities/source%20a/kind-a/a%2Fb%3Fc%23d%25e%20%C3%A9');
  });

  it.each([
    ['.', '~.'],
    ['..', '~..'],
    ['~', '~~'],
  ])('sends a stable ID or entity type of %j as %j, which no URL parser removes', async (value, segment) => {
    const { fetcher, asked } = answering(nodeOf('source-a', value, value));
    expect((await createApiClient(fetcher).getEntity({ sourceId: 'source-a', entityType: value, stableId: value })).ok).toBe(true);
    expect(asked[0]?.path).toBe(`/v1/entities/source-a/${segment}/${segment}`);
    expect(new URL(asked[0]?.path ?? '', 'http://localhost').pathname).toBe(`/v1/entities/source-a/${segment}/${segment}`);
  });

  it('asks for masking only when told to', async () => {
    const { fetcher, asked } = answering(nodeOf('source-a', 'kind-a', 'A-1'));
    const client = createApiClient(fetcher);
    await client.getEntity(REF);
    await client.getEntity(REF, { mask: true });
    expect(asked.map((entry) => entry.path)).toEqual(['/v1/entities/source-a/kind-a/A-1', '/v1/entities/source-a/kind-a/A-1?mask=true']);
  });

  it('gives a schema mismatch for a node that names another entity than the one asked for', async () => {
    const { fetcher } = answering(nodeOf('source-a', 'kind-a', 'A-2'));
    expect(await createApiClient(fetcher).getEntity(REF)).toEqual({ ok: false, failure: { code: 'SCHEMA_MISMATCH' } });
  });

  it('gives the error of the server for a refusal', async () => {
    const { fetcher } = answering({ error: { code: 'NOT_FOUND', message: 'Not found.', retryable: false, traceId: 'tr-1' } }, 404);
    expect(await createApiClient(fetcher).getEntity(REF)).toMatchObject({ ok: false, failure: { code: 'NOT_FOUND' } });
  });
});

describe('openInvestigation', () => {
  const request = { sourceId: 'source-a', entity: REF, caseRef: 'CASE-1' };
  const investigation = investigationOf(INVESTIGATION_A, 'source-a', 'kind-a', 'A-1');

  it('posts the request as JSON and parses the answer', async () => {
    const { fetcher, asked } = answering(openedOf(investigation, nodeOf('source-a', 'kind-a', 'A-1')), 201);
    const result = await createApiClient(fetcher).openInvestigation(request);
    expect(result.ok).toBe(true);
    expect(asked[0]?.path).toBe('/v1/investigations');
    expect(asked[0]?.init).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
  });

  it.each([
    ['an investigation of another source', openedOf(investigationOf(INVESTIGATION_A, 'source-b', 'kind-a', 'A-1'), nodeOf('source-a', 'kind-a', 'A-1'))],
    ['an investigation that started from another entity', openedOf(investigationOf(INVESTIGATION_A, 'source-a', 'kind-a', 'A-2'), nodeOf('source-a', 'kind-a', 'A-1'))],
    ['an entity that is not the one asked for', openedOf(investigation, nodeOf('source-a', 'kind-a', 'A-2'))],
  ])('gives a schema mismatch for %s', async (_name, body) => {
    const { fetcher } = answering(body, 201);
    expect(await createApiClient(fetcher).openInvestigation(request)).toEqual({ ok: false, failure: { code: 'SCHEMA_MISMATCH' } });
  });

  it.each([
    ['an available investigation with no entity', { investigation, created: true }],
    ['a repointed investigation with an entity', { investigation: { ...investigation, sourceState: 'repointed' }, created: false, entity: nodeOf('source-a', 'kind-a', 'A-1') }],
    ['a removed investigation reported as new', { investigation: { ...investigation, sourceState: 'removed' }, created: true }],
  ])('gives a schema mismatch for %s', async (_name, body) => {
    const { fetcher } = answering(body, 201);
    expect(await createApiClient(fetcher).openInvestigation(request)).toEqual({ ok: false, failure: { code: 'SCHEMA_MISMATCH' } });
  });

  it('takes an answer with no entity, which is what a repointed source gives', async () => {
    const { fetcher } = answering(openedOf({ ...investigation, sourceState: 'repointed' }, undefined, false), 200);
    expect(await createApiClient(fetcher).openInvestigation(request)).toMatchObject({ ok: true, value: { created: false } });
  });
});

describe('getInvestigation', () => {
  it('asks for the encoded identifier and parses the answer', async () => {
    const { fetcher, asked } = answering(readOf(investigationOf(INVESTIGATION_A, 'source-a', 'kind-a', 'A-1')));
    expect((await createApiClient(fetcher).getInvestigation(INVESTIGATION_A)).ok).toBe(true);
    expect(asked[0]?.path).toBe(`/v1/investigations/${INVESTIGATION_A}`);
  });

  it('gives a schema mismatch for an investigation with another identifier than the one asked for', async () => {
    const { fetcher } = answering(readOf(investigationOf('0192f000-0000-7000-8000-0000000000ff', 'source-a', 'kind-a', 'A-1')));
    expect(await createApiClient(fetcher).getInvestigation(INVESTIGATION_A)).toEqual({ ok: false, failure: { code: 'SCHEMA_MISMATCH' } });
  });
});

describe('an ID that a path cannot carry', () => {
  it.each([
    ['a long ID', 'x'.repeat(401)],
    ['an ID with a control character', 'a\u0000b'],
    ['an ID with an unpaired surrogate', 'a\ud800'],
  ])('is read through the body of the lookup, with %s, and the answer must name the same reference', async (_name, stableId) => {
    const ref = { sourceId: 'source-a', entityType: 'kind-a', stableId };
    const { fetcher, asked } = answering(nodeOf(ref.sourceId, ref.entityType, ref.stableId));
    const result = await createApiClient(fetcher).getEntity(ref, { mask: true });
    expect(result.ok).toBe(true);
    expect(asked[0]?.path).toBe('/v1/entities/lookup');
    expect(JSON.parse(asked[0]?.init?.body ?? '{}')).toEqual({ sourceId: 'source-a', mask: true, ref: { entityType: 'kind-a', stableId } });
    const other = answering(nodeOf(ref.sourceId, ref.entityType, 'another'));
    expect(await createApiClient(other.fetcher).getEntity(ref)).toEqual({ ok: false, failure: { code: 'SCHEMA_MISMATCH' } });
  });
});

describe('lookupEntity', () => {
  it('requires the same reference back for a reference, and only the same source and type for a value', async () => {
    const token = nodeOf('source-a', 'kind-a', 'p1.canonical');
    const byRef = await createApiClient(answering(token).fetcher).lookupEntity({ sourceId: 'source-a', ref: { entityType: 'kind-a', stableId: 'p1.canonical' } });
    expect(byRef.ok).toBe(true);
    const wrongRef = await createApiClient(answering(token).fetcher).lookupEntity({ sourceId: 'source-a', ref: { entityType: 'kind-a', stableId: 'p1.other' } });
    expect(wrongRef).toEqual({ ok: false, failure: { code: 'SCHEMA_MISMATCH' } });
    const byValue = await createApiClient(answering(token).fetcher).lookupEntity({ sourceId: 'source-a', value: { entityType: 'kind-a', value: '+1-212-555-0100' } });
    expect(byValue.ok).toBe(true);
    for (const wrong of [nodeOf('source-b', 'kind-a', 'p1.canonical'), nodeOf('source-a', 'kind-b', 'p1.canonical')]) {
      expect(await createApiClient(answering(wrong).fetcher).lookupEntity({ sourceId: 'source-a', value: { entityType: 'kind-a', value: 'v' } })).toEqual({ ok: false, failure: { code: 'SCHEMA_MISMATCH' } });
    }
  });
});

describe('openInvestigation by a value', () => {
  const value = { sourceId: 'source-a', entity: { sourceId: 'source-a', entityType: 'kind-a', value: '+1-212-555-0100' } };

  it('accepts the canonical reference of the same source and entity type, and refuses another source or type', async () => {
    const canonical = openedOf(investigationOf(INVESTIGATION_A, 'source-a', 'kind-a', 'p1.canonical'), nodeOf('source-a', 'kind-a', 'p1.canonical'));
    expect((await createApiClient(answering(canonical).fetcher).openInvestigation(value)).ok).toBe(true);
    const otherType = openedOf(investigationOf(INVESTIGATION_A, 'source-a', 'kind-b', 'p1.canonical'), nodeOf('source-a', 'kind-b', 'p1.canonical'));
    expect(await createApiClient(answering(otherType).fetcher).openInvestigation(value)).toEqual({ ok: false, failure: { code: 'SCHEMA_MISMATCH' } });
    const mixed = openedOf(investigationOf(INVESTIGATION_A, 'source-a', 'kind-a', 'p1.canonical'), nodeOf('source-a', 'kind-a', 'p1.different'));
    expect(await createApiClient(answering(mixed).fetcher).openInvestigation(value)).toEqual({ ok: false, failure: { code: 'SCHEMA_MISMATCH' } });
  });

  it('keeps the exact check for a reference', async () => {
    const reference = { sourceId: 'source-a', entity: { sourceId: 'source-a', entityType: 'kind-a', stableId: 'p1.canonical' } };
    const same = openedOf(investigationOf(INVESTIGATION_A, 'source-a', 'kind-a', 'p1.canonical'), nodeOf('source-a', 'kind-a', 'p1.canonical'));
    expect((await createApiClient(answering(same).fetcher).openInvestigation(reference)).ok).toBe(true);
    const different = openedOf(investigationOf(INVESTIGATION_A, 'source-a', 'kind-a', 'p1.other'), nodeOf('source-a', 'kind-a', 'p1.other'));
    expect(await createApiClient(answering(different).fetcher).openInvestigation(reference)).toEqual({ ok: false, failure: { code: 'SCHEMA_MISMATCH' } });
  });
});
