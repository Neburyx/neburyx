import { getEventListeners } from 'node:events';
import { describe, expect, it } from 'vitest';
import { RequestCancelled } from '../errors.js';
import { SEARCH_FACETS_ID } from '../gate/templates/search-facets.js';
import type { Gate, GatePage, GateRequest } from '../gate/types.js';
import { gateRequest, harness, LOCAL_PRINCIPAL, TestExecutor } from '../testing/gate.js';
import { searchMappingOf } from '../testing/search-app.js';
import { createSearchService } from './search-service.js';

const access = { require: () => Promise.resolve(), admit: () => undefined, readable: (call: { readonly sourceIds: readonly string[] }) => Promise.resolve([...call.sourceIds]) };
const EMPTY_PAGE: GatePage = { items: [{ nodes: [], edges: [], dropped: {}, warnings: [] }], hasMore: false };
const mapping = searchMappingOf();
const call = { traceId: 'tr-1', principal: LOCAL_PRINCIPAL, sourceId: 'demo', text: 'needle', mask: false };

function service(run: (request: GateRequest) => Promise<GatePage>, indexes?: { read: (request: { readonly signal?: AbortSignal }) => Promise<'unverified'> }) {
  const requests: GateRequest[] = [];
  const gate: Gate = {
    run: (request) => (requests.push(request), run(request)),
    runMany: () => Promise.reject(new Error('not used')),
  };
  return { requests, search: createSearchService({ gate, mapping, access, ...(indexes === undefined ? {} : { indexes: { read: (request) => indexes.read(request) } }) }) };
}

describe('a search whose request carries a signal', () => {
  it('hands it to the schema read and to every read it makes', async () => {
    const signal = new AbortController().signal;
    const seen: (AbortSignal | undefined)[] = [];
    const { search, requests } = service(() => Promise.resolve(EMPTY_PAGE), { read: (request) => (seen.push(request.signal), Promise.resolve('unverified' as const)) });
    await search.search({ ...call, signal });
    expect(seen).toEqual([signal]);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.signal === signal)).toBe(true);
  });

  it('hands it to the read of the next page of a group', async () => {
    const signal = new AbortController().signal;
    const { search, requests } = service(() => Promise.resolve(EMPTY_PAGE));
    await search.more({ ...call, group: 'exact', cursor: 'not-a-cursor', signal }).catch(() => undefined);
    expect(requests.every((request) => request.signal === signal)).toBe(true);
  });
});

describe('a search that is cancelled', () => {
  it('fails as a whole when the facet read sees the cancel while another group answered', async () => {
    const { search } = service((request) => (request.templateId === SEARCH_FACETS_ID ? Promise.reject(new RequestCancelled()) : Promise.resolve(EMPTY_PAGE)));
    await expect(search.search({ ...call, signal: new AbortController().signal })).rejects.toBeInstanceOf(RequestCancelled);
  });

  it('fails as a whole when the first group sees the cancel', async () => {
    const { search } = service(() => Promise.reject(new RequestCancelled()));
    await expect(search.search({ ...call, signal: new AbortController().signal })).rejects.toBeInstanceOf(RequestCancelled);
  });

  it('fails as a whole when the schema read sees the cancel: it is never handed to the reads as the schema failure', async () => {
    const { search, requests } = service(() => Promise.resolve(EMPTY_PAGE), { read: () => Promise.reject(new RequestCancelled()) });
    await expect(search.search({ ...call, signal: new AbortController().signal })).rejects.toBeInstanceOf(RequestCancelled);
    expect(requests).toEqual([]);
  });

  it('fails the next page of a group as a whole, not as that group\'s failure', async () => {
    const { search } = service(() => Promise.reject(new RequestCancelled()));
    await expect(search.more({ ...call, group: 'exact', cursor: 'c', signal: new AbortController().signal })).rejects.toBeInstanceOf(RequestCancelled);
  });
});

describe('the reads of one request that share a signal', () => {
  it('leave no abort listener on it once they have ended, and raise no listener warning', async () => {
    const warnings: string[] = [];
    const onWarning = (warning: Error): number => warnings.push(warning.name);
    process.on('warning', onWarning);
    const signal = new AbortController().signal;
    let peak = 0;
    const executor = new TestExecutor(async (each) => {
      peak = Math.max(peak, getEventListeners(signal, 'abort').length);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { status: 'rows', rows: Array.from({ length: each.rowLimit - 1 }, () => ({ title: 'x' })) };
    });
    const { gate } = harness({ executor });
    const runs = Array.from({ length: 7 }, () => gate.run(gateRequest({ signal })));
    await Promise.all(runs);
    await new Promise((resolve) => setImmediate(resolve));
    process.off('warning', onWarning);
    expect(peak).toBeGreaterThan(0);
    expect(getEventListeners(signal, 'abort')).toHaveLength(0);
    expect(warnings).not.toContain('MaxListenersExceededWarning');
  });
});
