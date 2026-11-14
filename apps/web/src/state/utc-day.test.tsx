import { act, cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClientState } from './client-state.js';
import { ClientStateProvider, useVisibleGraph } from './context.js';
import { key, node, edge } from './test-data.js';
import { useUtcDay } from './utc-day.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the UTC day', () => {
  it('changes at 00:00 UTC and not before', () => {
    vi.useFakeTimers({ now: Date.parse('2026-11-14T23:59:50Z') });
    const { result } = renderHook(() => useUtcDay());
    expect(result.current).toBe(Date.parse('2026-11-14T00:00:00Z'));
    act(() => void vi.advanceTimersByTime(9_000));
    expect(result.current).toBe(Date.parse('2026-11-14T00:00:00Z'));
    act(() => void vi.advanceTimersByTime(2_000));
    expect(result.current).toBe(Date.parse('2026-11-15T00:00:00Z'));
  });

  it('waits again when the timer fires before midnight by the clock, and still steps at midnight', () => {
    vi.useFakeTimers({ now: Date.parse('2026-11-14T23:59:50Z') });
    const { result } = renderHook(() => useUtcDay());
    vi.setSystemTime(Date.parse('2026-11-14T23:59:45Z'));
    act(() => void vi.advanceTimersByTime(11_000));
    expect(result.current).toBe(Date.parse('2026-11-14T00:00:00Z'));
    vi.setSystemTime(Date.parse('2026-11-15T00:00:00Z'));
    act(() => void vi.advanceTimersByTime(15_000));
    expect(result.current).toBe(Date.parse('2026-11-15T00:00:00Z'));
  });

  it('judges a window of days again for the new day on the drawn graph', () => {
    vi.useFakeTimers({ now: Date.parse('2026-11-14T23:59:50Z') });
    const state = createClientState();
    const nodes = [node('a', 'n0'), node('a', 'n1')];
    const link = { ...edge('a', 'e0', 'n0', 'n1'), observedAt: '2026-11-13T12:00:00Z' };
    state.bindSource('a');
    state.putResult(key('a'), { sourceId: 'a', nodes, edges: [link] });
    state.setLoaded([key('a')], nodes.map((candidate) => candidate.ref), [link.ref]);
    state.presentation.setMappedTypes({ entityTypes: ['type-a'], relationshipTypes: ['rel-a'], datedRelationships: [{ type: 'rel-a', from: 'type-a', to: 'type-a' }] });
    state.setTimeWindow({ days: 1 });
    const wrapper = ({ children }: { readonly children: ReactNode }) => <ClientStateProvider state={state}>{children}</ClientStateProvider>;
    const { result } = renderHook(() => useVisibleGraph(), { wrapper });
    expect(result.current.edges).toHaveLength(1);
    act(() => void vi.advanceTimersByTime(11_000));
    expect(result.current.edges).toHaveLength(0);
  });
});
