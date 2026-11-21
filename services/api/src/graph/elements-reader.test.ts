import { MAX_READ_REFS } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { AppError, RequestCancelled } from '../errors.js';
import type { ShownReader } from '../exports/shown-reader.js';
import type { MappingModel } from '../mapping/model.js';
import type { Principal } from '../seams/seams.js';
import { createElementsReader, createSourceElementsReader } from './elements-reader.js';

const principal = { id: 'p', displayName: 'P', role: 'investigator' } as Principal;
/** A source with a plain type and a keyed one (its stable ID is also a personal field). */
const MAPPING = { sources: [{ id: 'demo', entities: [{ type: 'widget', stableId: 'widgetId', pii: [] }, { type: 'phone', stableId: 'number', pii: ['number'] }] }] } as unknown as MappingModel;
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

describe('the reader of the elements of a source', () => {
  const source = { sourceId: 'demo', mask: false };
  const none = { nodes: [], edges: [], omitted: false, unresolved: false, unresolvedCount: 0, maskedFields: 0, notRetrieved: EXACT, uncounted: 0 };
  const build = (shownReader: ShownReader, counted: unknown[] = []) => createSourceElementsReader({ shownReader, access: access(counted), mapping: MAPPING, principal, traceId: 't', signal: new AbortController().signal });

  it('reads through the same shown reader with the mask of the scope and no investigation, counts the call once against the rate of the person, under the action of the read by references', async () => {
    const calls: unknown[] = [];
    const counted: unknown[] = [];
    const read = build(reader(async (call) => (calls.push(call), none)), counted);
    await read({ sourceId: 'demo', mask: true }, refs);
    expect(counted).toMatchObject([{ sourceId: 'demo', rate: 'count', auditAction: 'graph.read_refs', principal }]);
    expect(calls).toMatchObject([{ sourceId: 'demo', mask: true, entities: refs.entities }]);
  });

  it('gives back what the shown reader gave: the references that did not resolve and the flag that something was left out, as the reader of a view does', async () => {
    const read = build(reader(async () => ({ ...none, omitted: true, unresolved: true, unresolvedCount: 2 })));
    expect(await read(source, refs)).toMatchObject({ unresolved: 2, omitted: true });
  });

  it('reads nothing and counts nothing when a kind holds more references than a read takes, and reads when it holds exactly that many', async () => {
    let reads = 0;
    const counted: unknown[] = [];
    const read = build(reader(async () => (reads += 1, none)), counted);
    const many = (count: number) => ({ entities: Array.from({ length: count }, (_unused, index) => ref(`W-${index}`)), edges: [], aggregates: [], derived: [] });
    await read(source, many(MAX_READ_REFS));
    expect(reads).toBe(1);
    await expect(read(source, many(MAX_READ_REFS + 1))).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(reads).toBe(1);
    expect(counted).toHaveLength(1);
  });

  it('passes on the refusal of a source the person may not read, and the error of the shown reader, as they are', async () => {
    const denied = createSourceElementsReader({ shownReader: reader(async () => none), access: { require: async () => Promise.reject(new AppError('NOT_FOUND')) }, mapping: MAPPING, principal, traceId: 't', signal: new AbortController().signal });
    await expect(denied(source, refs)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const cancelled = build(reader(() => Promise.reject(new RequestCancelled())));
    await expect(cancelled(source, refs)).rejects.toBeInstanceOf(RequestCancelled);
  });

  it('leaves the references of a keyed type out of the read, since a typed value cannot stand for its token, and says something was left out', async () => {
    const calls: { entities: unknown }[] = [];
    const read = build(reader(async (call) => (calls.push({ entities: call.entities }), none)));
    const phone = { sourceId: 'demo', entityType: 'phone', stableId: '+1 555 0100' };
    const answer = await read(source, { entities: [ref('W-1'), phone], edges: [], aggregates: [], derived: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.entities).toEqual([ref('W-1')]);
    expect(answer).toMatchObject({ omitted: true, unresolved: 1 });
    const only = await read(source, { entities: [phone], edges: [], aggregates: [], derived: [] });
    expect(calls).toHaveLength(1);
    expect(only).toMatchObject({ omitted: true, unresolved: 1, nodes: [] });
  });
});
