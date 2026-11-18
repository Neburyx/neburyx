import { describe, expect, it } from 'vitest';
import { RequestCancelled } from '../errors.js';
import type { ShownReader } from '../exports/shown-reader.js';
import type { Principal } from '../seams/seams.js';
import { createElementsReader } from './elements-reader.js';

const principal = { id: 'p', displayName: 'P', role: 'investigator' } as Principal;
const ref = (id: string) => ({ sourceId: 'demo', entityType: 'widget', stableId: id });
const investigations = (state: 'available' | 'repointed' = 'available', sourceId = 'demo') => ({ read: async () => ({ investigation: { id: 'i', sourceId, sourceState: state } }) as never });
const EXACT = { value: 0, quality: 'exact', scope: 'coverage' } as const;
const refs = { entities: [ref('W-1')], edges: [], aggregates: [], derived: [] };
const scope = { investigationId: 'i', sourceId: 'demo', mask: true };
const reader = (read: ShownReader['read']) => ({ read });
const access = (counts: unknown[] = []) => ({ require: async (call: unknown) => void counts.push(call) });

describe('the reader of the elements of a view', () => {
  it('counts the click once against the rate of the person on the source, before it reads', async () => {
    const counted: unknown[] = [];
    const shownReader = reader(async () => ({ nodes: [], edges: [], omitted: false, unresolved: false, unresolvedCount: 0, maskedFields: 0, notRetrieved: EXACT, uncounted: 0 }));
    const read = createElementsReader({ shownReader, investigations: investigations(), access: access(counted), principal, traceId: 't', signal: new AbortController().signal });
    await read(scope, refs);
    expect(counted).toMatchObject([{ sourceId: 'demo', rate: 'count', principal }]);
  });

  it('reads through the shown reader of the exports with the mask of the request, and answers what it gave', async () => {
    const calls: unknown[] = [];
    const shownReader = reader(async (call) => (calls.push(call), { nodes: [], edges: [], omitted: true, unresolved: true, unresolvedCount: 2, maskedFields: 0, notRetrieved: { value: 148, quality: 'lowerBound', scope: 'coverage' }, uncounted: 25 }));
    const read = createElementsReader({ shownReader, investigations: investigations(), access: access(), principal, traceId: 't', signal: new AbortController().signal });
    expect(await read(scope, refs)).toEqual({ nodes: [], edges: [], unresolved: 2, omitted: true, notRetrieved: { value: 148, quality: 'lowerBound', scope: 'coverage' }, uncounted: 25 });
    expect(calls).toMatchObject([{ traceId: 't', principal, sourceId: 'demo', mask: true, entities: refs.entities, edges: [], aggregates: [], derived: [] }]);
  });

  it('refuses a source that was re-pointed before it reads anything', async () => {
    let reads = 0;
    const shownReader = reader(async () => (reads += 1, { nodes: [], edges: [], omitted: false, unresolved: false, unresolvedCount: 0, maskedFields: 0, notRetrieved: EXACT, uncounted: 0 }));
    const read = createElementsReader({ shownReader, investigations: investigations('repointed'), access: access(), principal, traceId: 't', signal: new AbortController().signal });
    await expect(read(scope, refs)).rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'source-changed', sourceState: 'repointed' } });
    expect(reads).toBe(0);
  });

  it('refuses an investigation that is for another source before it reads anything', async () => {
    let reads = 0;
    const shownReader = reader(async () => (reads += 1, { nodes: [], edges: [], omitted: false, unresolved: false, unresolvedCount: 0, maskedFields: 0, notRetrieved: EXACT, uncounted: 0 }));
    const read = createElementsReader({ shownReader, investigations: investigations('available', 'other'), access: access(), principal, traceId: 't', signal: new AbortController().signal });
    await expect(read(scope, refs)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(reads).toBe(0);
  });

  it('passes on the error of the shown reader as it is, a budget error and the cancellation of the client among them', async () => {
    const controller = new AbortController();
    const read = createElementsReader({ shownReader: reader(() => Promise.reject(new RequestCancelled())), investigations: investigations(), access: access(), principal, traceId: 't', signal: controller.signal });
    await expect(read(scope, refs)).rejects.toBeInstanceOf(RequestCancelled);
  });

  it('gives the shown reader a signal that aborts with the signal of the scope as well as with the request', async () => {
    const seen: AbortSignal[] = [];
    const shownReader = reader(async (call) => (call.signal === undefined ? undefined : seen.push(call.signal), { nodes: [], edges: [], omitted: false, unresolved: false, unresolvedCount: 0, maskedFields: 0, notRetrieved: EXACT, uncounted: 0 }));
    const own = new AbortController();
    const turn = new AbortController();
    const read = createElementsReader({ shownReader, investigations: investigations(), access: access(), principal, traceId: 't', signal: own.signal });
    await read({ ...scope, signal: turn.signal }, refs);
    await read(scope, refs);
    expect(seen.map((signal) => signal.aborted)).toEqual([false, false]);
    turn.abort();
    expect(seen.map((signal) => signal.aborted)).toEqual([true, false]);
    own.abort();
    expect(seen.map((signal) => signal.aborted)).toEqual([true, true]);
  });
});
