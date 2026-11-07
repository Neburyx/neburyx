import type { InvestigationListResponse, SourcesResponse } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import type { RequestState } from '../api/use-request.js';
import { listOf } from '../investigations/test-data.js';
import { source } from '../test-utils.js';
import { decideStart, type StartReads } from './start-decision.js';

const FAILURE = { code: 'NETWORK_UNAVAILABLE' } as const;
const sourcesOf = (...items: Parameters<typeof source>[1][]): RequestState<SourcesResponse> => ({ phase: 'ready', data: { items: items.map((overrides, index) => source(`s${index}`, overrides)), nextCursor: null } });
const demo = { synthetic: true } as const;
const real = (state: 'connected' | 'degraded' | 'unavailable' | 'unknown') => ({ synthetic: false, state }) as const;
const listWith = (investigations: number): InvestigationListResponse => {
  const base = listOf([]);
  return { ...base, counts: { ...base.counts, investigations: { value: investigations, quality: 'exact', scope: 'investigations' } } };
};
const ready = (investigations: number): RequestState<InvestigationListResponse> => ({ phase: 'ready', data: listWith(investigations) });

const reads = (overrides: Partial<StartReads>): StartReads => ({ sources: sourcesOf(demo), list: { phase: 'idle' }, asked: true, settledCount: undefined, ...overrides });

describe('which page the start address shows', () => {
  it.each([
    ['no source at all', sourcesOf()],
    ['only a synthetic source', sourcesOf(demo)],
    ['only synthetic sources, one connected and one not', sourcesOf(demo, { synthetic: true, state: 'unavailable' })],
    ['a real source that is unavailable', sourcesOf(real('unavailable'))],
    ['a real source that has not been tested', sourcesOf(real('unknown'))],
    ['a real source that is down beside a synthetic one', sourcesOf(demo, real('unavailable'))],
  ])('shows First run for no investigation and %s', (_name, sources) => {
    expect(decideStart(reads({ sources, list: ready(0), settledCount: 0 }))).toBe('first-run');
  });

  it.each([
    ['connected', real('connected')],
    ['degraded', real('degraded')],
  ])('shows Home for no investigation and a real source that is %s', (_name, overrides) => {
    expect(decideStart(reads({ sources: sourcesOf(demo, overrides), list: ready(0), settledCount: 0 }))).toBe('home');
  });

  it('shows Home for one investigation or more whatever the sources are', () => {
    for (const sources of [sourcesOf(), sourcesOf(demo), sourcesOf(real('unavailable')), sourcesOf(real('unknown'))]) {
      expect(decideStart(reads({ sources, list: ready(1), settledCount: 1 }))).toBe('home');
    }
  });

  it('shows Home for a held answer of one investigation or more while this visit has not settled, whether the read is under way or failed', () => {
    const held = listWith(2);
    expect(decideStart(reads({ list: { phase: 'loading', data: held } }))).toBe('home');
    expect(decideStart(reads({ list: { phase: 'ready', data: held, failure: FAILURE } }))).toBe('home');
    expect(decideStart(reads({ list: { phase: 'ready', data: held }, asked: false }))).toBe('home');
  });

  it('waits for a held answer of no investigation that is read again, and for a list or a sources answer that has not come', () => {
    expect(decideStart(reads({ list: { phase: 'loading', data: listWith(0) } }))).toBe('pending');
    expect(decideStart(reads({ list: { phase: 'ready', data: listWith(0) }, asked: false }))).toBe('pending');
    expect(decideStart(reads({ list: { phase: 'loading' } }))).toBe('pending');
    expect(decideStart(reads({ list: { phase: 'idle' } }))).toBe('pending');
    expect(decideStart(reads({ sources: { phase: 'loading' }, list: ready(0), settledCount: 0 }))).toBe('pending');
    expect(decideStart(reads({ sources: { phase: 'idle' }, list: ready(0), settledCount: 0 }))).toBe('pending');
  });

  it('shows Home for a read that failed with nothing held', () => {
    expect(decideStart(reads({ list: { phase: 'failed', failure: FAILURE } }))).toBe('home');
    expect(decideStart(reads({ list: { phase: 'ready', data: listWith(0), failure: FAILURE } }))).toBe('home');
    expect(decideStart(reads({ sources: { phase: 'failed', failure: FAILURE }, list: { phase: 'loading' } }))).toBe('home');
    expect(decideStart(reads({ sources: { phase: 'failed', failure: FAILURE }, list: ready(0), settledCount: 0 }))).toBe('home');
  });

  it('decides from the sources held when a later sources read is under way or failed', () => {
    const held = sourcesOf(demo);
    if (held.phase !== 'ready') throw new Error('expected a held answer');
    for (const sources of [{ phase: 'loading', data: held.data }, { phase: 'ready', data: held.data, failure: FAILURE }] as const) {
      expect(decideStart(reads({ sources, list: ready(0), settledCount: 0 }))).toBe('first-run');
    }
  });

  it('keeps the settled count of this visit when the list is read again or the re-read fails', () => {
    expect(decideStart(reads({ list: { phase: 'loading', data: listWith(0) }, settledCount: 0 }))).toBe('first-run');
    expect(decideStart(reads({ list: { phase: 'ready', data: listWith(0), failure: FAILURE }, settledCount: 0 }))).toBe('first-run');
  });
});
