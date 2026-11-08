import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GraphNode } from '@neburyx/contracts';
import { elementKey } from '../state/keys.js';
import { edge, key as testKey, node } from '../state/test-data.js';
import { panelWorkspace, searchAnswer, searchFor, settle, setText, TIMEOUT, TYPEAHEAD_DEBOUNCE_MS, wait } from './panel-test-kit.js';
import { hit } from './search-test-kit.js';

beforeEach(() => void vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const first = hit('a', 'ACC-100');
const second = hit('a', 'ACC-200');
const keyOf = (candidate: GraphNode): string => elementKey(candidate.ref);

async function withRows(options: Parameters<typeof panelWorkspace>[0] = {}) {
  const parts = await panelWorkspace(options);
  await searchFor('ACC');
  act(() => parts.searches[0]?.answer({ ok: true, value: searchAnswer('a', [first], [second]) }));
  await settle();
  return parts;
}

const addButton = (title: string): HTMLElement => screen.getByRole('button', { name: `Add ${title}` });
const loadedRefs = (parts: { readonly state: { investigation: { getState(): { nodeRefs: readonly { stableId: string }[] } } } }): string[] => parts.state.investigation.getState().nodeRefs.map((ref) => ref.stableId);

describe('adding one entity from the Add from source tab', () => {
  it('sends one entity read and, when it answers, adds exactly that entity beside the ones already on the canvas, with every position as it was, and the row says it is on the canvas', async () => {
    const parts = await withRows();
    act(() => parts.state.presentation.setPositions(new Map([[elementKey(node('a', 'ACC-1').ref), { x: 10, y: 20 }]])));
    const before = new Map(parts.state.presentation.view.getState().positions);
    fireEvent.click(addButton('Title ACC-100'));
    expect(parts.loads).toHaveLength(1);
    expect(parts.loads[0]?.key).toBe('kind-a/ACC-100');
    expect(loadedRefs(parts)).toEqual(['ACC-1']);
    act(() => parts.loads[0]?.answer({ ok: true, value: first }));
    await settle();
    expect(loadedRefs(parts)).toEqual(['ACC-1', 'ACC-100']);
    expect(parts.state.investigation.getState().edgeRefs).toEqual([]);
    const after = parts.state.presentation.view.getState().positions;
    for (const [key, position] of before) expect(after.get(key)).toEqual(position);
    expect([...after.keys()].filter((key) => !before.has(key))).toEqual([keyOf(first)]);
    expect(screen.queryByRole('button', { name: 'Add Title ACC-100' })).toBeNull();
    expect(screen.getByRole('button', { name: 'On canvas: Title ACC-100' })).toBeDefined();
    expect(screen.getByText('Added Title ACC-100.')).toBeDefined();
    expect(parts.searches).toHaveLength(1);
  });

  it('reads an entity whose ID is a dot', async () => {
    const parts = await panelWorkspace();
    await searchFor('..');
    const dot = hit('a', '.');
    act(() => parts.searches[0]?.answer({ ok: true, value: searchAnswer('a', [dot], []) }));
    await settle();
    fireEvent.click(addButton('Title .'));
    expect(parts.loads[0]?.key).toBe('kind-a/.');
  });

  it('shows On canvas and never Add for an entity that is already there, and selects and centres it when it is chosen', async () => {
    const parts = await panelWorkspace({ nodes: [node('a', 'ACC-1'), first] });
    await searchFor('ACC');
    act(() => parts.searches[0]?.answer({ ok: true, value: searchAnswer('a', [first], [second]) }));
    await settle();
    expect(screen.queryByRole('button', { name: 'Add Title ACC-100' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'On canvas: Title ACC-100' }));
    expect([...parts.state.presentation.view.getState().selection]).toEqual([keyOf(first)]);
    expect(parts.renderer()?.centered).toEqual([keyOf(first)]);
    expect(parts.loads).toEqual([]);
  });

  it('shows a hidden entity again, one only, when Find is chosen on it, and selects, centres and announces it', async () => {
    const parts = await panelWorkspace({ nodes: [node('a', 'ACC-1'), first] });
    parts.state.hide([keyOf(first), keyOf(node('a', 'ACC-1'))]);
    await searchFor('ACC');
    act(() => parts.searches[0]?.answer({ ok: true, value: searchAnswer('a', [first], [second]) }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'On canvas: Title ACC-100' }));
    await settle();
    expect([...parts.state.presentation.view.getState().hidden]).toEqual([keyOf(node('a', 'ACC-1'))]);
    expect([...parts.state.presentation.view.getState().selection]).toEqual([keyOf(first)]);
    expect(parts.renderer()?.centered).toEqual([keyOf(first)]);
    expect(parts.state.presentation.view.getState().moveNote?.text).toBe('Shown again: Title ACC-100');
  });

  it('leaves focus first when Find is chosen on a loaded entity that focus sets aside, then selects and centres it', async () => {
    const parts = await panelWorkspace({ nodes: [node('a', 'ACC-1'), first] });
    parts.state.focusOn(keyOf(node('a', 'ACC-1')));
    await searchFor('ACC');
    act(() => parts.searches[0]?.answer({ ok: true, value: searchAnswer('a', [first], [second]) }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'On canvas: Title ACC-100' }));
    await settle();
    expect(parts.state.presentation.view.getState().neighborhoodFocus).toBeUndefined();
    expect([...parts.state.presentation.view.getState().selection]).toEqual([keyOf(first)]);
    expect(parts.renderer()?.centered).toEqual([keyOf(first)]);
    expect(parts.state.presentation.view.getState().moveNote?.text).toBe('Focus left.');
  });

  it('keeps focus when Find is chosen on an entity inside it, and shows a hidden one inside it again', async () => {
    const parts = await panelWorkspace({ nodes: [node('a', 'ACC-1'), first], edges: [{ ...edge('a', 'e1', 'ACC-1', 'ACC-100'), from: node('a', 'ACC-1').ref, to: first.ref }] });
    parts.state.focusOn(keyOf(node('a', 'ACC-1')));
    parts.state.hide([keyOf(first)]);
    await searchFor('ACC');
    act(() => parts.searches[0]?.answer({ ok: true, value: searchAnswer('a', [first], [second]) }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'On canvas: Title ACC-100' }));
    await settle();
    expect(parts.state.presentation.view.getState().neighborhoodFocus).toBe(keyOf(node('a', 'ACC-1')));
    expect(parts.state.presentation.view.getState().hidden.size).toBe(0);
    expect([...parts.state.presentation.view.getState().selection]).toEqual([keyOf(first)]);
    expect(parts.state.presentation.view.getState().moveNote?.text).toBe('Shown again: Title ACC-100');
  });

  it('leaves focus and shows a hidden entity again when Find is chosen on a hidden entity that focus sets aside', async () => {
    const parts = await panelWorkspace({ nodes: [node('a', 'ACC-1'), first] });
    parts.state.focusOn(keyOf(node('a', 'ACC-1')));
    parts.state.hide([keyOf(first)]);
    await searchFor('ACC');
    act(() => parts.searches[0]?.answer({ ok: true, value: searchAnswer('a', [first], [second]) }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'On canvas: Title ACC-100' }));
    await settle();
    expect(parts.state.presentation.view.getState().neighborhoodFocus).toBeUndefined();
    expect(parts.state.presentation.view.getState().hidden.size).toBe(0);
    expect(parts.renderer()?.centered).toEqual([keyOf(first)]);
    expect(parts.state.presentation.view.getState().moveNote?.text).toBe('Focus left. Shown again: Title ACC-100');
  });

  it('leaves focus when an entity is added while focus is on, since it would be loaded and not drawn', async () => {
    const parts = await withRows();
    parts.state.focusOn(keyOf(node('a', 'ACC-1')));
    fireEvent.click(addButton('Title ACC-100'));
    act(() => parts.loads[0]?.answer({ ok: true, value: first }));
    await settle();
    expect(loadedRefs(parts)).toEqual(['ACC-1', 'ACC-100']);
    expect(parts.state.presentation.view.getState().neighborhoodFocus).toBeUndefined();
    expect(parts.state.visibleGraph().nodes).toHaveLength(2);
  });

  it('sends one entity read and adds one entity when Add is pressed twice before the answer', async () => {
    const parts = await withRows();
    fireEvent.click(addButton('Title ACC-100'));
    fireEvent.click(addButton('Title ACC-100'));
    expect(parts.loads).toHaveLength(1);
    act(() => parts.loads[0]?.answer({ ok: true, value: first }));
    await settle();
    expect(loadedRefs(parts).filter((id) => id === 'ACC-100')).toHaveLength(1);
  });

  it('keeps every entity and relationship that was there, and both entities, when two entities are added and the answers come in the other order', async () => {
    const parts = await panelWorkspace({ nodes: [node('a', 'ACC-1'), node('a', 'ACC-2')] });
    act(() => {
      const shown = parts.state.investigation.getState();
      const link = edge('a', 'REL-1', 'ACC-1', 'ACC-2');
      const [existing] = shown.resultKeys;
      if (existing === undefined) throw new Error('nothing is loaded');
      parts.state.putResult({ ...existing, params: 'relationship' }, { sourceId: 'a', nodes: [], edges: [link] });
      parts.state.setLoaded([...shown.resultKeys, { ...existing, params: 'relationship' }], shown.nodeRefs, [link.ref]);
    });
    await searchFor('ACC');
    act(() => parts.searches[0]?.answer({ ok: true, value: searchAnswer('a', [first], [second]) }));
    await settle();
    fireEvent.click(addButton('Title ACC-100'));
    fireEvent.click(addButton('Title ACC-200'));
    expect(parts.loads).toHaveLength(2);
    act(() => parts.loads[1]?.answer({ ok: true, value: second }));
    await settle();
    act(() => parts.loads[0]?.answer({ ok: true, value: first }));
    await settle();
    expect(loadedRefs(parts).sort()).toEqual(['ACC-1', 'ACC-100', 'ACC-2', 'ACC-200']);
    expect(parts.state.investigation.getState().edgeRefs).toHaveLength(1);
    expect(parts.state.loadedGraph().edges).toHaveLength(1);
  });

  it.each([
    ['a timeout', TIMEOUT],
    ['an entity that is not there', { code: 'NOT_FOUND', message: 'gone', retryable: false, traceId: 'tr-9' } as const],
    ['a source that is unavailable', { code: 'SOURCE_UNAVAILABLE', message: 'down', retryable: true, traceId: 'tr-8' } as const],
    ['a network that is down', { code: 'NETWORK_UNAVAILABLE' } as const],
  ])('adds nothing and changes nothing on the canvas for %s, shows the failure on the row and lets Add be pressed again', async (_name, failure) => {
    const parts = await withRows();
    const before = { refs: loadedRefs(parts), positions: new Map(parts.state.presentation.view.getState().positions), selection: [...parts.state.presentation.view.getState().selection] };
    fireEvent.click(addButton('Title ACC-100'));
    act(() => parts.loads[0]?.answer({ ok: false, failure }));
    await settle();
    expect(loadedRefs(parts)).toEqual(before.refs);
    expect(parts.state.presentation.view.getState().positions).toEqual(before.positions);
    expect([...parts.state.presentation.view.getState().selection]).toEqual(before.selection);
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
    expect(screen.queryByRole('region', { name: 'Request status' })).toBeNull();
    expect(parts.reported).not.toHaveBeenCalled();
    fireEvent.click(addButton('Title ACC-100'));
    expect(parts.loads).toHaveLength(2);
  });

  it('refuses an answer that names another source or another entity than the one asked for, and adds nothing', async () => {
    const parts = await withRows();
    fireEvent.click(addButton('Title ACC-100'));
    act(() => parts.loads[0]?.answer({ ok: true, value: hit('other', 'ACC-100') }));
    await settle();
    expect(loadedRefs(parts)).toEqual(['ACC-1']);
    fireEvent.click(addButton('Title ACC-100'));
    act(() => parts.loads[1]?.answer({ ok: true, value: hit('a', 'ACC-999') }));
    await settle();
    expect(loadedRefs(parts)).toEqual(['ACC-1']);
  });

  it('adds nothing when the answer comes after the investigation changed, the panel was closed, or the mask was switched on', async () => {
    const changed = await withRows();
    fireEvent.click(addButton('Title ACC-100'));
    act(() => {
      changed.state.show({ id: 'inv-2', sourceId: 'a', record: { title: 'Another', caseRef: null, save: { kind: 'unsaved' } }, resultKeys: [], nodeRefs: [], edgeRefs: [] }, []);
    });
    expect(changed.loads[0]?.signal?.aborted).toBe(true);
    act(() => changed.loads[0]?.answer({ ok: true, value: first }));
    await settle();
    expect(loadedRefs(changed)).toEqual([]);
    cleanup();

    const closed = await withRows();
    fireEvent.click(addButton('Title ACC-100'));
    fireEvent.click(screen.getByRole('button', { name: 'Close Search' }));
    expect(closed.loads[0]?.signal?.aborted).toBe(true);
    act(() => closed.loads[0]?.answer({ ok: true, value: first }));
    await settle();
    expect(loadedRefs(closed)).toEqual(['ACC-1']);
    cleanup();

    const masked = await withRows();
    fireEvent.click(addButton('Title ACC-100'));
    act(() => masked.state.setMask(true));
    expect(masked.loads[0]?.signal?.aborted).toBe(true);
    act(() => masked.loads[0]?.answer({ ok: true, value: first }));
    await settle();
    expect(loadedRefs(masked)).toEqual(['ACC-1']);
  });

  it('reads the entity with the mask when the session asks for it', async () => {
    const parts = await panelWorkspace({ mask: true });
    await searchFor('ACC');
    act(() => parts.searches[0]?.answer({ ok: true, value: searchAnswer('a', [first], []) }));
    await settle();
    fireEvent.click(addButton('Title ACC-100'));
    expect(parts.loads[0]?.mask).toBe(true);
  });

  it('does not search again, and keeps the focus on the row, when an entity is added', async () => {
    const parts = await withRows();
    const button = addButton('Title ACC-100');
    button.focus();
    fireEvent.click(button);
    act(() => parts.loads[0]?.answer({ ok: true, value: first }));
    await settle();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'On canvas: Title ACC-100' }));
    setText('ACC');
    await wait(TYPEAHEAD_DEBOUNCE_MS * 2);
    expect(parts.searches).toHaveLength(1);
  });

  it('keeps two entities whose type and ID join into the same text apart', async () => {
    const parts = await panelWorkspace();
    await searchFor('ACC');
    const slashed = hit('a', 'id', {}, 'kind-a/part');
    const joined = hit('a', 'part/id', {}, 'kind-a');
    act(() => parts.searches[0]?.answer({ ok: true, value: searchAnswer('a', [slashed, joined], []) }));
    await settle();
    fireEvent.click(addButton('Title id'));
    fireEvent.click(addButton('Title part/id'));
    act(() => parts.loads[0]?.answer({ ok: true, value: slashed }));
    act(() => parts.loads[1]?.answer({ ok: true, value: joined }));
    await settle();
    expect(parts.state.loadedGraph().nodes.map((candidate) => keyOf(candidate)).sort()).toEqual([keyOf(node('a', 'ACC-1')), keyOf(slashed), keyOf(joined)].sort());
  });

  it('does not touch what another investigation holds when the same entity is added to this one', async () => {
    const parts = await panelWorkspace({ bound: false });
    const show = (id: string) => {
      const opened = { ...testKey('a'), params: `open:${id}` };
      act(() => {
        parts.state.show({ id, sourceId: 'a', record: { title: id, caseRef: null, save: { kind: 'unsaved' } }, resultKeys: [opened], nodeRefs: [node('a', 'ACC-1').ref], edgeRefs: [] }, [{ key: opened, result: { sourceId: 'a', nodes: [node('a', 'ACC-1')], edges: [] } }]);
      });
    };
    const addFirst = async (round: number) => {
      await searchFor('ACC');
      act(() => parts.searches[round]?.answer({ ok: true, value: searchAnswer('a', [first], []) }));
      await settle();
      fireEvent.click(addButton('Title ACC-100'));
      act(() => parts.loads[round]?.answer({ ok: true, value: first }));
      await settle();
    };
    show('inv-a');
    await addFirst(0);
    const added = (): string[] => [...parts.state.server.getState().results.keys()].filter((name) => name.includes('added'));
    expect(added()).toHaveLength(1);
    show('inv-b');
    fireEvent.click(screen.getByRole('tab', { name: 'Add from source' }));
    await addFirst(1);
    expect(added()).toHaveLength(2);
    act(() => void parts.state.resume('inv-a', false));
    expect(loadedRefs(parts)).toEqual(['ACC-1', 'ACC-100']);
  });

  it('ignores the late answer when the investigation changed away and back inside one batch of updates', async () => {
    const parts = await panelWorkspace({ bound: false });
    const opened = { ...testKey('a'), params: 'open:inv-a' };
    const sameInvestigation = () => ({ id: 'inv-a', sourceId: 'a', record: { title: 'inv-a', caseRef: null, save: { kind: 'unsaved' as const } }, resultKeys: [opened], nodeRefs: [node('a', 'ACC-1').ref], edgeRefs: [] });
    const results = [{ key: opened, result: { sourceId: 'a', nodes: [node('a', 'ACC-1')], edges: [] } }];
    act(() => void parts.state.show(sameInvestigation(), results));
    await searchFor('ACC');
    act(() => parts.searches[0]?.answer({ ok: true, value: searchAnswer('a', [first], []) }));
    await settle();
    fireEvent.click(addButton('Title ACC-100'));
    act(() => {
      parts.state.show({ id: 'inv-b', sourceId: 'a', record: { title: 'inv-b', caseRef: null, save: { kind: 'unsaved' } }, resultKeys: [], nodeRefs: [], edgeRefs: [] }, []);
      parts.state.show(sameInvestigation(), results);
    });
    expect(parts.loads[0]?.signal?.aborted).toBe(true);
    act(() => parts.loads[0]?.answer({ ok: true, value: first }));
    await settle();
    expect(loadedRefs(parts)).toEqual(['ACC-1']);
  });

  it('says an entity that is not in the source is not in the source, with the trace ID, and lets Add be pressed again', async () => {
    const parts = await withRows();
    fireEvent.click(addButton('Title ACC-100'));
    act(() => parts.loads[0]?.answer({ ok: false, failure: { code: 'NOT_FOUND', message: 'gone', retryable: false, traceId: 'tr-9' } }));
    await settle();
    expect(screen.getByText('That entity is not in the source.')).toBeDefined();
    expect(screen.getByText('trace tr-9')).toBeDefined();
    expect(screen.queryByText(/not configured/)).toBeNull();
    expect(addButton('Title ACC-100')).toBeDefined();
  });

  it('shows a failure and lets Add be pressed again when the entity read rejects', async () => {
    const parts = await withRows();
    const spy = vi.spyOn(parts.client, 'getEntity').mockRejectedValue(new Error('the network went away'));
    fireEvent.click(addButton('Title ACC-100'));
    await settle();
    expect(screen.getByText(/The entity could not be loaded\./)).toBeDefined();
    spy.mockRestore();
    fireEvent.click(addButton('Title ACC-100'));
    expect(parts.loads).toHaveLength(1);
  });
});

describe('the workspace of the Add tab', () => {
  it('shows a Timed out banner when something reports a timeout to it, so the absence of one in the failures above is a real check', async () => {
    const parts = await panelWorkspace();
    act(() => void parts.banner.showFailure({ code: 'QUERY_TIMEOUT', message: 'x', retryable: true, traceId: 'tr-1', details: { timeoutMs: 5000 } }, { source: 'Demo source' }));
    expect(screen.getByRole('region', { name: 'Request status' })).toBeDefined();
  });
});

describe('Find and Add of an entity whose type a filter switched off', () => {
  const mapped = { entityTypes: ['type-a', 'kind-a'], relationshipTypes: [] };
  const status = (): string => [...document.querySelectorAll('.search-panel-status')].at(-1)?.textContent ?? '';

  it('switches the type on, says so in the status line and the announcement, and selects and centres the entity', async () => {
    const parts = await panelWorkspace({ nodes: [node('a', 'ACC-1'), first] });
    parts.state.presentation.setMappedTypes(mapped);
    parts.state.setEntityTypeOff('kind-a', true);
    await searchFor('ACC');
    act(() => parts.searches[0]?.answer({ ok: true, value: searchAnswer('a', [first], [second]) }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'On canvas: Title ACC-100' }));
    await settle();
    expect(parts.state.presentation.view.getState().typeFilter.offEntityTypes.size).toBe(0);
    expect([...parts.state.presentation.view.getState().selection]).toEqual([keyOf(first)]);
    expect(parts.renderer()?.centered).toEqual([keyOf(first)]);
    expect(status()).toBe('KIND-A shown again by the filters');
    expect(parts.state.presentation.view.getState().moveNote?.text).toBe('KIND-A shown again by the filters');
  });

  it('shows an entity that is also hidden by hand again, and names both', async () => {
    const parts = await panelWorkspace({ nodes: [node('a', 'ACC-1'), first] });
    parts.state.presentation.setMappedTypes(mapped);
    parts.state.hide([keyOf(first)]);
    parts.state.setEntityTypeOff('kind-a', true);
    await searchFor('ACC');
    act(() => parts.searches[0]?.answer({ ok: true, value: searchAnswer('a', [first], [second]) }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'On canvas: Title ACC-100' }));
    await settle();
    expect(parts.state.presentation.view.getState().hidden.size).toBe(0);
    expect(parts.state.presentation.view.getState().typeFilter.offEntityTypes.size).toBe(0);
    expect(status()).toBe('Shown again: Title ACC-100; KIND-A shown again by the filters');
    expect(parts.state.presentation.view.getState().moveNote?.text).toBe(status());
  });

  it('loads an added entity of an off type, switches the type on and says so beside Added', async () => {
    const parts = await withRows({ nodes: [node('a', 'ACC-1')] });
    parts.state.presentation.setMappedTypes(mapped);
    parts.state.setEntityTypeOff('kind-a', true);
    fireEvent.click(addButton('Title ACC-100'));
    act(() => parts.loads[0]?.answer({ ok: true, value: first }));
    await settle();
    expect(parts.state.presentation.view.getState().typeFilter.offEntityTypes.size).toBe(0);
    expect(parts.state.visibleGraph().nodes.map((entry) => entry.ref.stableId)).toContain('ACC-100');
    expect(status()).toBe('Added Title ACC-100. KIND-A shown again by the filters');
  });

  it('leaves the filters alone when the add fails, and for an entity of a type that is on', async () => {
    const parts = await withRows({ nodes: [node('a', 'ACC-1')] });
    parts.state.presentation.setMappedTypes(mapped);
    parts.state.setEntityTypeOff('type-a', true);
    fireEvent.click(addButton('Title ACC-100'));
    act(() => parts.loads[0]?.answer({ ok: false, failure: TIMEOUT }));
    await settle();
    expect([...parts.state.presentation.view.getState().typeFilter.offEntityTypes]).toEqual(['type-a']);
    fireEvent.click(addButton('Title ACC-100'));
    act(() => parts.loads[1]?.answer({ ok: true, value: first }));
    await settle();
    expect([...parts.state.presentation.view.getState().typeFilter.offEntityTypes]).toEqual(['type-a']);
    expect(status()).toBe('Added Title ACC-100.');
  });
});
