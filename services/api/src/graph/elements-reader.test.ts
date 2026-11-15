import type { ReadRefsResponse } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { AppError, RequestCancelled } from '../errors.js';
import type { Principal } from '../seams/seams.js';
import { createElementsReader } from './elements-reader.js';
import type { ReadRefsService } from './read-refs-service.js';

const principal = { id: 'p', displayName: 'P', role: 'investigator' } as Principal;
const ref = (id: string) => ({ sourceId: 'demo', entityType: 'widget', stableId: id });
const investigations = (state: 'available' | 'repointed' = 'available') => ({
  read: async () => ({ investigation: { id: 'i', sourceId: 'demo', sourceState: state } }) as never,
});
const empty: ReadRefsResponse = { nodes: [], edges: [], missing: { entities: [], edges: [] } };

describe('the reader of the elements of a view', () => {
  it('shares one deadline across all its reads and stops reading when it is spent', async () => {
    let reads = 0;
    const readRefs: ReadRefsService = {
      read: (call) =>
        new Promise((resolve, reject) => {
          reads += 1;
          const timer = setTimeout(() => resolve(empty), 20);
          call.signal?.addEventListener('abort', () => (clearTimeout(timer), reject(new RequestCancelled())), { once: true });
        }),
    };
    const read = createElementsReader({ readRefs, investigations: investigations(), principal, traceId: 't', signal: new AbortController().signal, requestTimeoutMs: 30 });
    const refs = { entities: Array.from({ length: 450 }, (_unused, index) => ref(`W-${index}`)), edges: [], aggregates: [], derived: [] };
    await expect(read({ investigationId: 'i', sourceId: 'demo', mask: false }, refs)).rejects.toMatchObject({ code: 'QUERY_TIMEOUT', details: { timeoutMs: 30 } });
    expect(reads).toBeLessThan(5);
  });

  it('refuses a source that was re-pointed before it reads anything', async () => {
    let reads = 0;
    const readRefs: ReadRefsService = { read: async () => (reads += 1, empty) };
    const read = createElementsReader({ readRefs, investigations: investigations('repointed'), principal, traceId: 't', signal: new AbortController().signal });
    await expect(read({ investigationId: 'i', sourceId: 'demo', mask: false }, { entities: [ref('W-1')], edges: [], aggregates: [], derived: [] })).rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'source-changed', sourceState: 'repointed' } });
    expect(reads).toBe(0);
  });

  it('passes on a budget error of the gate as it is', async () => {
    const readRefs: ReadRefsService = { read: async () => Promise.reject(new AppError('QUERY_BUDGET_EXCEEDED', { maxPage: 50 })) };
    const read = createElementsReader({ readRefs, investigations: investigations(), principal, traceId: 't', signal: new AbortController().signal });
    await expect(read({ investigationId: 'i', sourceId: 'demo', mask: false }, { entities: [ref('W-1')], edges: [], aggregates: [], derived: [] })).rejects.toMatchObject({ code: 'QUERY_BUDGET_EXCEEDED', details: { maxPage: 50 } });
  });

  it('answers the request cancellation of the client as itself, not as a timeout', async () => {
    const controller = new AbortController();
    const readRefs: ReadRefsService = { read: (call) => new Promise((_resolve, reject) => call.signal?.addEventListener('abort', () => reject(new RequestCancelled()), { once: true })) };
    const read = createElementsReader({ readRefs, investigations: investigations(), principal, traceId: 't', signal: controller.signal, requestTimeoutMs: 10_000 });
    const pending = read({ investigationId: 'i', sourceId: 'demo', mask: false }, { entities: [ref('W-1')], edges: [], aggregates: [], derived: [] });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(RequestCancelled);
    await expect(pending).rejects.not.toBeInstanceOf(AppError);
  });
});
