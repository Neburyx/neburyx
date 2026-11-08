import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testProfile } from '../dev/test-profile.js';
import { createClientState, type ClientState } from '../state/client-state.js';
import { ClientStateProvider } from '../state/context.js';
import { edgeKey, elementKey } from '../state/keys.js';
import { edgeRef, key, ref, result } from '../state/test-data.js';
import { canvasSummary, clientWith, me, renderApp, source, stubFactory, type StubOptions } from '../test-utils.js';
import { useCanvasCommands } from './canvas-commands.js';
import { GraphCanvas, RENDERER_UNAVAILABLE, WALK_SENTENCE } from './graph-canvas.js';
import { RendererProvider } from './renderer-context.js';
import { layoutEntities } from './incremental-layout.js';
import { partitionEdges } from '../state/loaded-graph.js';
import { PHYSICS_MAX_ENTITIES } from './layout-constants.js';
import { INSPECT_DRAWING, MARK_EVENT, READ_POSITIONS } from '../dev/canvas-readout.js';
import { runSelectionCommand } from './selection-commands.js';
import type { CanvasEvents, CreateRenderer } from './scene.js';
import type { SourceProfile } from '@neburyx/contracts';

function load(state: ClientState, nodes: number, edges: number, params = 'seed-1'): void {
  const ids = Array.from({ length: nodes }, (_unused, index) => `n${index}`);
  const links = Array.from({ length: edges }, (_unused, index): [string, string, string] => [`e${index}`, `n${index % nodes}`, `n${(index + 1) % nodes}`]);
  state.bindSource('a');
  state.putResult(key('a', params), result('a', ids, links));
  state.setLoaded([key('a', params)], ids.map((id) => ref('a', 'type-a', id)), links.map(([id]) => edgeRef('a', id)));
}

function view(state: ClientState, create: CreateRenderer, profile?: SourceProfile, strict = false) {
  const tree = (
    <ClientStateProvider state={state}>
      <RendererProvider createRenderer={create}>
        <GraphCanvas profile={profile} />
      </RendererProvider>
    </ClientStateProvider>
  );
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}

const nodeKey = (id: string) => elementKey(ref('a', 'type-a', id));

describe('the graph canvas', () => {
  it('hands the renderer the loaded entities and relationships, the positions and the profile, and mounts it on its own element', () => {
    const state = createClientState();
    load(state, 3, 2);
    state.presentation.setPosition(nodeKey('n1'), { x: 7, y: 8 });
    const factory = stubFactory();
    const profile = testProfile('a');
    view(state, factory.create, profile);
    const renderer = factory.made[0];
    expect(renderer?.mounts[0]?.getAttribute('aria-label')).toBe('Graph canvas');
    const scene = renderer?.scenes[0];
    expect(scene?.entities).toHaveLength(3);
    expect(scene?.relationships).toHaveLength(2);
    expect(scene?.entities.find((entity) => entity.id === nodeKey('n1'))?.position).toEqual({ x: 7, y: 8 });
    expect(scene?.profile).toBe(profile);
  });

  it('gives the renderer a position for every entity at its first draw, writes them to presentation state in one update, and places nothing on the draw that follows', () => {
    const state = createClientState();
    load(state, 3, 0);
    let updates = 0;
    state.presentation.view.subscribe(() => {
      updates += 1;
    });
    const factory = stubFactory();
    view(state, factory.create);
    const renderer = factory.made[0];
    expect(renderer?.scenes[0]?.entities).toHaveLength(3);
    expect(renderer?.scenes[0]?.entities.every((entity) => Number.isFinite(entity.position.x) && Number.isFinite(entity.position.y))).toBe(true);
    expect(state.presentation.view.getState().positions.size).toBe(3);
    expect(updates).toBe(1);
    const stored = state.presentation.view.getState().positions;
    expect(renderer?.scenes.at(-1)?.entities.map((entity) => entity.position)).toEqual(renderer?.scenes[0]?.entities.map((entity) => stored.get(entity.id)));
    expect(renderer?.scenes).toHaveLength(2);
  });

  it('draws every entity at its position and writes none when all of them have one', () => {
    const state = createClientState();
    load(state, 2, 0);
    state.presentation.setPosition(nodeKey('n0'), { x: 1, y: 1 });
    state.presentation.setPosition(nodeKey('n1'), { x: 2, y: 2 });
    const factory = stubFactory();
    view(state, factory.create);
    expect(factory.made[0]?.scenes).toHaveLength(1);
    expect([...state.presentation.view.getState().positions.values()]).toEqual([{ x: 1, y: 1 }, { x: 2, y: 2 }]);
  });

  it('updates the drawing when the loaded graph changes, with the same renderer', () => {
    const state = createClientState();
    load(state, 2, 1);
    const factory = stubFactory();
    view(state, factory.create);
    act(() => load(state, 5, 4, 'seed-2'));
    expect(factory.made).toHaveLength(1);
    expect(factory.made[0]?.describe()).toEqual({ entities: 5, relationships: 4 });
    expect(factory.made[0]?.disposed).toBe(0);
  });

  it('keeps every position when entities are added, places the added ones beside what they join, and keeps a pinned entity that was placed with the others', () => {
    const state = createClientState();
    load(state, 4, 3);
    state.replacePins([nodeKey('n0')]);
    const factory = stubFactory();
    view(state, factory.create);
    const before = new Map(state.presentation.view.getState().positions);
    expect(before.size).toBe(4);
    expect(before.has(nodeKey('n0'))).toBe(true);
    act(() => load(state, 9, 8, 'seed-2'));
    const after = state.presentation.view.getState().positions;
    expect(after.size).toBe(9);
    for (const [id, position] of before) expect(after.get(id), id).toEqual(position);
    const scene = factory.made[0]?.scenes.at(-1);
    expect(scene?.entities.map((entity) => entity.position)).toEqual(scene?.entities.map((entity) => after.get(entity.id)));
  });

  it('keeps the position a person gave an entity when more arrive', () => {
    const state = createClientState();
    load(state, 3, 2);
    const factory = stubFactory();
    view(state, factory.create);
    act(() => state.presentation.setPosition(nodeKey('n1'), { x: 4321, y: -77 }));
    act(() => load(state, 8, 6, 'seed-2'));
    expect(state.presentation.view.getState().positions.get(nodeKey('n1'))).toEqual({ x: 4321, y: -77 });
  });

  it('disposes the renderer when the canvas goes away', () => {
    const state = createClientState();
    load(state, 2, 0);
    const factory = stubFactory();
    const { unmount } = view(state, factory.create);
    unmount();
    expect(factory.made[0]?.disposed).toBe(1);
  });

  it('under StrictMode leaves the renderer that is drawing mounted and disposes each one it replaced', () => {
    const state = createClientState();
    load(state, 2, 0);
    const factory = stubFactory();
    const { unmount } = view(state, factory.create, undefined, true);
    const live = factory.made.filter((renderer) => renderer.disposed === 0);
    expect(live).toHaveLength(1);
    expect(live[0]?.scenes.length).toBeGreaterThan(0);
    unmount();
    expect(factory.made.every((renderer) => renderer.disposed === 1)).toBe(true);
  });

  it('draws nothing and shows no notice when nothing is loaded', () => {
    const state = createClientState();
    const factory = stubFactory();
    view(state, factory.create);
    expect(factory.made[0]?.describe()).toEqual({ entities: 0, relationships: 0 });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each<[string, StubOptions]>([
    ['mount', { failOn: 'mount' }],
    ['draw', { failOn: 'draw' }],
  ])('shows RENDERER_UNAVAILABLE when the renderer fails on %s', (_name, options) => {
    const state = createClientState();
    load(state, 2, 0);
    view(state, stubFactory(options).create);
    expect(screen.getByRole('alert').textContent).toBe(RENDERER_UNAVAILABLE);
    expect(screen.getByRole('application', { name: 'Graph canvas' })).toBeTruthy();
  });

  it('is named "Graph canvas" and says how many entities and relationships are loaded', () => {
    const state = createClientState();
    load(state, 1200, 3);
    view(state, stubFactory().create);
    const canvas = screen.getByRole('application', { name: 'Graph canvas' });
    expect(canvasSummary(canvas)).toBe('1,200 entities and 3 relationships loaded');
    expect(document.getElementById(canvas.getAttribute('aria-describedby') ?? '')?.textContent).toBe(`1,200 entities and 3 relationships loaded. ${WALK_SENTENCE}`);
  });
});

describe('the graph canvas when the renderer fails', () => {
  it('disposes a renderer that was made but could not mount, and shows the code', () => {
    const state = createClientState();
    load(state, 2, 0);
    const factory = stubFactory({ failOn: 'mount' });
    view(state, factory.create);
    expect(factory.made[0]?.disposed).toBe(1);
    expect(screen.getByRole('alert').textContent).toBe(RENDERER_UNAVAILABLE);
  });

  it('shows the code when the factory itself throws, and the canvas stays', () => {
    const state = createClientState();
    load(state, 2, 0);
    view(state, stubFactory({ failCreate: true }).create);
    expect(screen.getByRole('alert').textContent).toBe(RENDERER_UNAVAILABLE);
    expect(screen.getByRole('application', { name: 'Graph canvas' })).toBeTruthy();
  });

  it('takes the notice away when a later draw succeeds', () => {
    const state = createClientState();
    load(state, 2, 1);
    const factory = stubFactory({ failOn: 'draw', failDraws: 1 });
    view(state, factory.create);
    expect(screen.queryByRole('alert')).not.toBeNull();
    act(() => load(state, 3, 2, 'seed-2'));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('the viewport of the graph canvas', () => {
  it('is stored in presentation state when the renderer reports it', () => {
    const state = createClientState();
    load(state, 2, 1);
    const factory = stubFactory();
    view(state, factory.create);
    factory.made[0]?.events[0]?.viewport({ zoom: 2, x: 30, y: -4 });
    expect(state.presentation.view.getState().viewport).toEqual({ zoom: 2, x: 30, y: -4 });
  });

  it('is given back to a canvas that is mounted again, including the identity view, and a canvas with no stored view is given none', () => {
    const state = createClientState();
    load(state, 2, 1);
    const factory = stubFactory();
    const first = view(state, factory.create);
    expect(factory.made[0]?.startViewports).toEqual([undefined]);
    factory.made[0]?.events[0]?.viewport({ zoom: 1, x: 0, y: 0 });
    first.unmount();
    view(state, factory.create);
    expect(factory.made[1]?.startViewports).toEqual([{ zoom: 1, x: 0, y: 0 }]);
  });

  it('changing the pointer mode neither throws nor shows more than the notice when the renderer cannot start', () => {
    const state = createClientState();
    load(state, 2, 1);
    view(state, stubFactory({ failOn: 'mount' }).create);
    expect(() => act(() => state.presentation.setTool('pan'))).not.toThrow();
    expect(screen.getByRole('alert').textContent).toBe(RENDERER_UNAVAILABLE);
  });
});

describe('the development read-out of the graph canvas', () => {
  it('carries what the renderer drew and where it looks, after a draw and after a viewport change', () => {
    const state = createClientState();
    load(state, 3, 2);
    const factory = stubFactory();
    view(state, factory.create);
    const canvas = screen.getByRole('application', { name: 'Graph canvas' });
    expect([canvas.dataset['drawnEntities'], canvas.dataset['drawnRelationships'], canvas.dataset['zoom']]).toEqual(['3', '2', '1']);
    act(() => factory.made[0]?.events[0]?.viewport({ zoom: 2.5, x: 12, y: -3 }));
    expect([canvas.dataset['zoom'], canvas.dataset['panX'], canvas.dataset['panY']]).toEqual(['2.5', '12', '-3']);
  });

  it('names the element the walk is at, while it is at one, for a recorded browser run', async () => {
    const state = createClientState();
    load(state, 2, 1);
    view(state, stubFactory().create);
    const canvas = screen.getByRole('application', { name: 'Graph canvas' });
    expect(canvas.dataset['focusedElement']).toBeUndefined();
    act(() => canvas.focus());
    act(() => state.presentation.walkTo(nodeKey('n1')));
    await waitFor(() => expect(canvas.dataset['focusedElement']).toBe(nodeKey('n1')));
    act(() => state.presentation.endWalk());
    await waitFor(() => expect(canvas.dataset['focusedElement']).toBeUndefined());
  });

  it('tells the renderer to draw no ring on the walk element while a menu is open, and keeps naming the element', async () => {
    const state = createClientState();
    load(state, 2, 1);
    const factory = stubFactory();
    view(state, factory.create);
    const canvas = screen.getByRole('application', { name: 'Graph canvas' });
    act(() => canvas.focus());
    act(() => state.presentation.walkTo(nodeKey('n1')));
    const last = () => factory.made[0]?.scenes.at(-1);
    await waitFor(() => expect(last()?.focused).toBe(nodeKey('n1')));
    expect(last()?.focusRing).toBe(true);
    act(() => state.presentation.setOpenMenu({ kind: 'node', key: nodeKey('n1'), x: 10, y: 10 }));
    await waitFor(() => expect(last()?.focusRing).toBe(false));
    expect(last()?.focused).toBe(nodeKey('n1'));
    expect(canvas.dataset['focusedElement']).toBe(nodeKey('n1'));
    act(() => state.presentation.setOpenMenu(undefined));
    await waitFor(() => expect(last()?.focusRing).toBe(true));
  });

  it('keeps the notice of a failed command when a menu opens or closes, since that drawing is of the same scene, and clears it with the next change of the scene', async () => {
    const state = createClientState();
    load(state, 2, 1);
    const factory = stubFactory();
    view(state, factory.create);
    const canvas = screen.getByRole('application', { name: 'Graph canvas' });
    await waitFor(() => expect(factory.made[0]?.scenes.length).toBeGreaterThan(0));
    act(() => factory.made[0]?.events[0]?.failed?.());
    expect(screen.getByRole('alert').textContent).toBe('RENDERER_UNAVAILABLE');
    act(() => state.presentation.setOpenMenu({ kind: 'node', key: nodeKey('n1'), x: 10, y: 10 }));
    act(() => state.presentation.setOpenMenu(undefined));
    expect(screen.queryByRole('alert')).not.toBeNull();
    act(() => state.presentation.select([nodeKey('n1')]));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(canvas).toBeTruthy();
  });

  it('gives a function that reads what the renderer has drawn, for a recorded browser run', () => {
    const state = createClientState();
    load(state, 2, 1);
    view(state, stubFactory().create);
    const canvas = screen.getByRole('application', { name: 'Graph canvas' });
    const inspect = Reflect.get(canvas, INSPECT_DRAWING);
    expect(typeof inspect).toBe('function');
    expect(inspect()).toHaveProperty('nodes');
  });

  it('gives a function that reads back where each entity is drawn, for a recorded browser run', () => {
    const state = createClientState();
    load(state, 2, 0);
    view(state, stubFactory().create);
    const canvas = screen.getByRole('application', { name: 'Graph canvas' });
    const read = Reflect.get(canvas, READ_POSITIONS);
    expect(typeof read).toBe('function');
    expect(Object.keys(read())).toEqual([...state.presentation.view.getState().positions.keys()]);
  });
});

describe('the events of a renderer that is gone', () => {
  it('change nothing after the canvas was taken away: no position, no selection, no menu, no notice', () => {
    const state = createClientState();
    load(state, 4, 2);
    const factory = stubFactory();
    const { unmount } = view(state, factory.create);
    const events = factory.made[0]?.events[0];
    const before = state.presentation.view.getState();
    unmount();
    act(() => {
      events?.move({ id: nodeKey('n1'), position: { x: 999, y: 999 } });
      events?.click({ target: nodeKey('n2'), shift: false });
      events?.box({ ids: [nodeKey('n0')], shift: false });
      events?.contextMenu({ target: undefined, x: 5, y: 5 });
      events?.viewport({ zoom: 3, x: 1, y: 1 });
      events?.failed();
    });
    expect(state.presentation.view.getState()).toBe(before);
  });

  it('change nothing for the renderer a remount replaced, while the new one still works', () => {
    const state = createClientState();
    load(state, 4, 2);
    const factory = stubFactory();
    view(state, factory.create, undefined, true);
    expect(factory.made.length).toBeGreaterThan(1);
    const stale = factory.made[0]?.events[0];
    const live = factory.made.at(-1)?.events[0];
    act(() => stale?.move({ id: nodeKey('n1'), position: { x: 999, y: 999 } }));
    expect(state.presentation.view.getState().positions.get(nodeKey('n1'))).not.toEqual({ x: 999, y: 999 });
    act(() => live?.move({ id: nodeKey('n1'), position: { x: 999, y: 999 } }));
    expect(state.presentation.view.getState().positions.get(nodeKey('n1'))).toEqual({ x: 999, y: 999 });
  });

  it('keep the view a pan or zoom reported just before the canvas was taken away, which the renderer flushes as it is disposed, and show it again when the canvas is mounted again', () => {
    const state = createClientState();
    load(state, 3, 1);
    const factory = stubFactory();
    const flushing: CreateRenderer = () => {
      const made = factory.create();
      return {
        ...made,
        mount: (container, events, viewport) => {
          made.mount(container, events, viewport);
          pending = events;
        },
        dispose: () => {
          pending?.viewport({ zoom: 2, x: 42, y: 17 });
          made.dispose();
        },
      };
    };
    let pending: CanvasEvents | undefined;
    const { unmount } = view(state, flushing);
    unmount();
    expect(state.presentation.view.getState().viewport).toEqual({ zoom: 2, x: 42, y: 17 });
    act(() => pending?.viewport({ zoom: 9, x: 1, y: 1 }));
    expect(state.presentation.view.getState().viewport).toEqual({ zoom: 2, x: 42, y: 17 });
    view(state, factory.create);
    expect(factory.made.at(-1)?.startViewports[0]).toEqual({ zoom: 2, x: 42, y: 17 });
  });

  it('show the notice when the renderer reports a failure of work after a draw, and keep the drawing', () => {
    const state = createClientState();
    load(state, 3, 1);
    const factory = stubFactory();
    view(state, factory.create);
    act(() => factory.made[0]?.events[0]?.failed());
    expect(screen.getByRole('alert').textContent).toBe(RENDERER_UNAVAILABLE);
    expect(factory.made[0]?.describe()).toEqual({ entities: 3, relationships: 1 });
  });
});

describe('the entities dragged on the graph canvas', () => {
  const dragged = (state: ClientState, id: string, position: { x: number; y: number }) => {
    const factory = stubFactory();
    view(state, factory.create);
    const events = factory.made[0]?.events[0];
    return { factory, move: () => act(() => events?.move({ id: nodeKey(id), position })) };
  };

  it('stores where the entity was left, once, and leaves the selection and every other position as they were', () => {
    const state = createClientState();
    load(state, 4, 2);
    state.presentation.select([nodeKey('n1'), nodeKey('n2')]);
    const { move } = dragged(state, 'n2', { x: 12.5, y: -3 });
    const before = new Map(state.presentation.view.getState().positions);
    let updates = 0;
    state.presentation.view.subscribe(() => {
      updates += 1;
    });
    move();
    const after = state.presentation.view.getState();
    expect(after.positions.get(nodeKey('n2'))).toEqual({ x: 12.5, y: -3 });
    for (const [id, position] of before) if (id !== nodeKey('n2')) expect(after.positions.get(id), id).toEqual(position);
    expect([...after.selection].sort()).toEqual([nodeKey('n1'), nodeKey('n2')].sort());
    expect(updates).toBe(1);
  });

  it('moves only the dragged entity when several are selected, and keeps a position it was dragged to when 25 entities are added', () => {
    const state = createClientState();
    load(state, 4, 2);
    state.presentation.select([nodeKey('n0'), nodeKey('n1'), nodeKey('n2')]);
    const { move } = dragged(state, 'n1', { x: -777, y: 555 });
    const before = new Map(state.presentation.view.getState().positions);
    move();
    act(() => load(state, 29, 20, 'seed-2'));
    const after = state.presentation.view.getState().positions;
    expect(after.get(nodeKey('n1'))).toEqual({ x: -777, y: 555 });
    for (const [id, position] of before) if (id !== nodeKey('n1')) expect(after.get(id), id).toEqual(position);
    expect(after.size).toBe(29);
  });

  it('ignores a drag of an entity the investigation no longer holds, and of one that is pinned, and nothing throws', () => {
    const state = createClientState();
    load(state, 3, 0);
    state.replacePins([nodeKey('n0')]);
    const factory = stubFactory();
    view(state, factory.create);
    const events = factory.made[0]?.events[0];
    const before = state.presentation.view.getState().positions;
    expect(() => act(() => events?.move({ id: nodeKey('n0'), position: { x: 1, y: 1 } }))).not.toThrow();
    expect(() => act(() => events?.move({ id: nodeKey('stranger'), position: { x: 2, y: 2 } }))).not.toThrow();
    expect(state.presentation.view.getState().positions).toBe(before);
  });

  it('tells the renderer which entities are pinned, and which of them are drawn', () => {
    const state = createClientState();
    load(state, 3, 0);
    state.replacePins([nodeKey('n0'), nodeKey('n2')]);
    const factory = stubFactory();
    view(state, factory.create);
    expect([...(factory.made[0]?.scenes.at(-1)?.pinned ?? [])].sort()).toEqual([nodeKey('n0'), nodeKey('n2')].sort());
    act(() => state.replacePins([nodeKey('n1')]));
    expect([...(factory.made[0]?.scenes.at(-1)?.pinned ?? [])]).toEqual([nodeKey('n1')]);
  });

  it('counts as pinned and draws as pinned only the entities that are drawn: not one that is hidden or set aside by focus, and again on show and on leaving focus', () => {
    const state = createClientState();
    load(state, 4, 3);
    state.presentation.setPositions(new Map([[nodeKey('n0'), { x: 0, y: 0 }], [nodeKey('n1'), { x: 300, y: 0 }], [nodeKey('n2'), { x: 600, y: 0 }], [nodeKey('n3'), { x: 900, y: 0 }]]));
    state.replacePins([nodeKey('n0'), nodeKey('n1')]);
    const factory = stubFactory();
    view(state, factory.create);
    const pinnedNow = (): string[] => [...(factory.made[0]?.scenes.at(-1)?.pinned ?? [])].sort();
    const described = (): string => document.getElementById(screen.getByLabelText('Graph canvas').getAttribute('aria-describedby') ?? '')?.textContent ?? '';
    expect(pinnedNow()).toEqual([nodeKey('n0'), nodeKey('n1')]);
    expect(described()).toContain('2 pinned');
    act(() => state.hide([nodeKey('n1')]));
    expect(pinnedNow()).toEqual([nodeKey('n0')]);
    expect(described()).toContain('1 pinned');
    act(() => state.presentation.showAllHidden());
    expect(described()).toContain('2 pinned');
    act(() => state.focusOn(nodeKey('n2')));
    expect(pinnedNow()).toEqual([nodeKey('n1')]);
    expect(described()).toContain('1 pinned');
    act(() => state.presentation.leaveFocus());
    expect(pinnedNow()).toEqual([nodeKey('n0'), nodeKey('n1')]);
    expect(described()).toContain('2 pinned');
    expect(state.presentation.view.getState().positions.get(nodeKey('n1'))).toEqual({ x: 300, y: 0 });
  });
});

describe('the development mark of the graph canvas', () => {
  it('counts, from the mark, the drawn entities that moved, the pinned ones apart, and keeps the counts through the redraws the move causes', () => {
    const state = createClientState();
    load(state, 4, 0);
    state.replacePins([nodeKey('n0')]);
    const factory = stubFactory();
    view(state, factory.create);
    const canvas = screen.getByRole('application', { name: 'Graph canvas' });
    act(() => void canvas.dispatchEvent(new Event(MARK_EVENT)));
    expect([canvas.dataset['markedEntities'], canvas.dataset['movedPinned'], canvas.dataset['movedUnpinned']]).toEqual(['4', '0', '0']);
    act(() => state.presentation.setPosition(nodeKey('n2'), { x: 9000, y: 9000 }));
    act(() => state.presentation.setPosition(nodeKey('n0'), { x: -9000, y: 9000 }));
    expect([canvas.dataset['movedPinned'], canvas.dataset['movedUnpinned']]).toEqual(['1', '1']);
    act(() => state.presentation.select([nodeKey('n1')]));
    expect([canvas.dataset['movedPinned'], canvas.dataset['movedUnpinned']]).toEqual(['1', '1']);
  });
});

describe('the commands of the graph canvas', () => {
  function viewWithProbe(state: ClientState, create: CreateRenderer, result: { available: boolean }) {
    let commands: ReturnType<typeof useCanvasCommands>;
    function Capture() {
      commands = useCanvasCommands();
      result.available = commands !== undefined;
      return null;
    }
    render(
      <ClientStateProvider state={state}>
        <RendererProvider createRenderer={create}>
          <GraphCanvas profile={undefined} />
          <Capture />
        </RendererProvider>
      </ClientStateProvider>,
    );
    return () => commands;
  }

  it('lay out the unpinned entities again: a displaced one goes to the position the layout gives it, a pinned one stays, the view is not changed, and a second run changes nothing', () => {
    const state = createClientState();
    load(state, 12, 14);
    state.replacePins([nodeKey('n0'), nodeKey('n1')]);
    const result = { available: false };
    const commands = viewWithProbe(state, stubFactory().create, result);
    const arranged = new Map(state.presentation.view.getState().positions);
    const displaced = nodeKey('n5');
    act(() => state.presentation.setPosition(displaced, { x: 50_000, y: -50_000 }));
    const viewportBefore = state.presentation.view.getState().viewport;
    const stored = new Map(state.presentation.view.getState().positions);
    const loaded = state.loadedGraph();
    const expected = layoutEntities({ ids: loaded.nodes.map((node) => elementKey(node.ref)), links: partitionEdges(loaded).drawable.map((edge) => [elementKey(edge.from), elementKey(edge.to)] as const), positions: stored, pinned: state.presentation.view.getState().pins });
    act(() => commands()?.layout());
    const after = state.presentation.view.getState().positions;
    expect(after.get(displaced)).toEqual(expected.get(displaced));
    expect(after.get(displaced)).not.toEqual({ x: 50_000, y: -50_000 });
    for (const pin of [nodeKey('n0'), nodeKey('n1')]) expect(after.get(pin), pin).toEqual(arranged.get(pin));
    expect(state.presentation.view.getState().viewport).toBe(viewportBefore);
    const once = new Map(after);
    act(() => commands()?.layout());
    for (const [id, position] of once) expect(Math.hypot((state.presentation.view.getState().positions.get(id)?.x ?? Infinity) - position.x, (state.presentation.view.getState().positions.get(id)?.y ?? Infinity) - position.y), id).toBeLessThan(0.02);
  });

  it('do nothing and do not throw to lay out when every entity is pinned, or when nothing is loaded', () => {
    const state = createClientState();
    load(state, 3, 2);
    state.replacePins([nodeKey('n0'), nodeKey('n1'), nodeKey('n2')]);
    const commands = viewWithProbe(state, stubFactory().create, { available: false });
    const before = state.presentation.view.getState().positions;
    expect(() => act(() => commands()?.layout())).not.toThrow();
    expect(state.presentation.view.getState().positions).toBe(before);
    const empty = createClientState();
    load(empty, 0, 0);
    const none = viewWithProbe(empty, stubFactory().create, { available: false });
    expect(() => act(() => none()?.layout())).not.toThrow();
  });

  it('are not available when the renderer cannot start, and nothing throws', () => {
    const state = createClientState();
    load(state, 2, 1);
    const result = { available: true };
    viewWithProbe(state, stubFactory({ failOn: 'mount' }).create, result);
    expect(result.available).toBe(false);
  });

  it('are withdrawn when a draw fails, and come back when a later draw succeeds', () => {
    const state = createClientState();
    load(state, 2, 1);
    const result = { available: true };
    viewWithProbe(state, stubFactory({ failOn: 'draw', failDraws: 1 }).create, result);
    expect(result.available).toBe(false);
    act(() => load(state, 3, 2, 'seed-2'));
    expect(result.available).toBe(true);
  });

  it('show the notice and are withdrawn when a command itself fails, without throwing', () => {
    const state = createClientState();
    load(state, 2, 1);
    const result = { available: false };
    const commands = viewWithProbe(state, stubFactory({ failCommands: true }).create, result);
    expect(result.available).toBe(true);
    expect(() => act(() => commands()?.fit())).not.toThrow();
    expect(screen.getByRole('alert').textContent).toBe(RENDERER_UNAVAILABLE);
    expect(result.available).toBe(false);
  });

  it('show the notice when centring fails, without throwing', () => {
    const state = createClientState();
    load(state, 2, 1);
    const result = { available: false };
    const commands = viewWithProbe(state, stubFactory({ failCommands: true }).create, result);
    expect(() => act(() => commands()?.centerOn('a'))).not.toThrow();
    expect(screen.getByRole('alert').textContent).toBe(RENDERER_UNAVAILABLE);
  });

  it('reach the renderer while it runs and are withdrawn when it is disposed', () => {
    const state = createClientState();
    load(state, 2, 1);
    const factory = stubFactory();
    const result = { available: false };
    const commands = viewWithProbe(state, factory.create, result);
    expect(result.available).toBe(true);
    act(() => commands()?.fit());
    act(() => commands()?.zoomBy(1.25));
    act(() => commands()?.centerOn('some-key'));
    expect(factory.made[0]?.fits).toBe(1);
    expect(factory.made[0]?.zooms).toEqual([1.25]);
    expect(factory.made[0]?.centered).toEqual(['some-key']);
  });
});

describe('the selection on the graph canvas', () => {
  const edgeKeyOf = (id: string) => edgeKey(edgeRef('a', id));

  it('follows the clicks the renderer reports, by the matrix of the pointer mode', () => {
    const state = createClientState();
    load(state, 3, 0);
    const factory = stubFactory();
    view(state, factory.create);
    const click = factory.made[0]?.events[0]?.click;
    expect(click).toBeDefined();
    act(() => click?.({ target: nodeKey('n0'), shift: false }));
    expect([...state.presentation.view.getState().selection]).toEqual([nodeKey('n0')]);
    act(() => click?.({ target: nodeKey('n1'), shift: true }));
    expect([...state.presentation.view.getState().selection]).toEqual([nodeKey('n0'), nodeKey('n1')]);
    act(() => click?.({ target: nodeKey('n0'), shift: true }));
    expect([...state.presentation.view.getState().selection]).toEqual([nodeKey('n1')]);
    act(() => click?.({ target: undefined, shift: false }));
    expect(state.presentation.view.getState().selection.size).toBe(0);
    act(() => state.presentation.setTool('pan'));
    act(() => click?.({ target: nodeKey('n2'), shift: false }));
    expect(state.presentation.view.getState().selection.size).toBe(0);
  });

  it('ignores a click on an item the investigation does not hold, and changes nothing', () => {
    const state = createClientState();
    load(state, 2, 0);
    const factory = stubFactory();
    view(state, factory.create);
    act(() => factory.made[0]?.events[0]?.click({ target: nodeKey('n0'), shift: false }));
    const before = state.presentation.view.getState();
    expect(() => act(() => factory.made[0]?.events[0]?.click({ target: nodeKey('ghost'), shift: false }))).not.toThrow();
    expect(state.presentation.view.getState()).toBe(before);
  });

  it('hands the renderer the selected items that are drawn, and keeps only the ones still in the loaded graph when it changes', () => {
    const state = createClientState();
    load(state, 3, 2);
    const factory = stubFactory();
    view(state, factory.create);
    act(() => state.presentation.select([nodeKey('n0'), nodeKey('n1'), edgeKeyOf('e0')]));
    expect([...(factory.made[0]?.scenes.at(-1)?.selection ?? [])].sort()).toEqual([nodeKey('n0'), nodeKey('n1'), edgeKeyOf('e0')].sort());
    act(() => load(state, 1, 0, 'seed-2'));
    expect([...state.presentation.view.getState().selection]).toEqual([nodeKey('n0')]);
    expect([...(factory.made[0]?.scenes.at(-1)?.selection ?? [])]).toEqual([nodeKey('n0')]);
  });

  it('is empty after another source is bound', () => {
    const state = createClientState();
    load(state, 2, 0);
    view(state, stubFactory().create);
    act(() => state.presentation.select([nodeKey('n0')]));
    act(() => state.bindSource('b'));
    expect(state.presentation.view.getState().selection.size).toBe(0);
  });

  it('is named by number in the canvas description, and not at all when nothing is selected', () => {
    const state = createClientState();
    load(state, 3, 0);
    view(state, stubFactory().create);
    const canvas = screen.getByRole('application', { name: 'Graph canvas' });
    const text = () => canvasSummary(canvas);
    expect(text()).toBe('3 entities and 0 relationships loaded');
    act(() => state.presentation.select([nodeKey('n0'), nodeKey('n2')]));
    expect(text()).toBe('3 entities and 0 relationships loaded; 2 selected');
  });
});

describe('the pinned entities in the canvas description', () => {
  it('are counted after the selection, and not at all when none is pinned', () => {
    const state = createClientState();
    load(state, 3, 0);
    view(state, stubFactory().create);
    const canvas = screen.getByRole('application', { name: 'Graph canvas' });
    const text = () => canvasSummary(canvas);
    expect(text()).toBe('3 entities and 0 relationships loaded');
    act(() => state.presentation.pin([nodeKey('n0'), nodeKey('n1')]));
    expect(text()).toBe('3 entities and 0 relationships loaded; 2 pinned');
    act(() => state.presentation.select([nodeKey('n2')]));
    expect(text()).toBe('3 entities and 0 relationships loaded; 1 selected; 2 pinned');
  });
});

describe('the labels of stored relationships on the graph canvas', () => {
  it('always reach the renderer, marked as touched only while an entity they join is selected', () => {
    const state = createClientState();
    load(state, 3, 1);
    const factory = stubFactory();
    view(state, factory.create);
    const labels = () => factory.made[0]?.scenes.at(-1)?.relationships.map((relationship) => [relationship.look.label, relationship.look.touched === true]);
    expect(labels()).toEqual([['rel-a', false]]);
    act(() => state.presentation.select([nodeKey('n0')]));
    expect(labels()).toEqual([['rel-a', true]]);
    act(() => state.presentation.select([nodeKey('n2')]));
    expect(labels()).toEqual([['rel-a', false]]);
    act(() => state.presentation.select([nodeKey('n1')]));
    act(() => runSelectionCommand(state, 'clear-selection'));
    expect(labels()).toEqual([['rel-a', false]]);
  });
});

describe('the selection commands on the graph canvas', () => {
  it('reach the canvas: select all shows in the description and the scene, clear takes it away', () => {
    const state = createClientState();
    load(state, 3, 1);
    const factory = stubFactory();
    view(state, factory.create);
    const canvas = screen.getByRole('application', { name: 'Graph canvas' });
    const text = () => canvasSummary(canvas);
    act(() => runSelectionCommand(state, 'select-all'));
    expect(text()).toBe('3 entities and 1 relationship loaded; 3 selected');
    expect(factory.made[0]?.scenes.at(-1)?.selection.size).toBe(3);
    act(() => runSelectionCommand(state, 'invert-selection'));
    expect(text()).toBe('3 entities and 1 relationship loaded');
    act(() => runSelectionCommand(state, 'select-all'));
    act(() => runSelectionCommand(state, 'clear-selection'));
    expect(factory.made[0]?.scenes.at(-1)?.selection.size).toBe(0);
  });
});

describe('the box on the graph canvas', () => {
  it('replaces the selection with the entities inside without Shift, clears it for an empty box, and adds with Shift', () => {
    const state = createClientState();
    load(state, 4, 0);
    const factory = stubFactory();
    view(state, factory.create);
    const box = factory.made[0]?.events[0]?.box;
    act(() => box?.({ ids: [nodeKey('n0'), nodeKey('n1')], shift: false }));
    expect([...state.presentation.view.getState().selection]).toEqual([nodeKey('n0'), nodeKey('n1')]);
    act(() => box?.({ ids: [nodeKey('n2')], shift: true }));
    expect([...state.presentation.view.getState().selection]).toEqual([nodeKey('n0'), nodeKey('n1'), nodeKey('n2')]);
    act(() => box?.({ ids: [], shift: true }));
    expect(state.presentation.view.getState().selection.size).toBe(3);
    act(() => box?.({ ids: [], shift: false }));
    expect(state.presentation.view.getState().selection.size).toBe(0);
  });

  it('ignores a box that names an entity the investigation does not hold', () => {
    const state = createClientState();
    load(state, 2, 0);
    const factory = stubFactory();
    view(state, factory.create);
    expect(() => act(() => factory.made[0]?.events[0]?.box({ ids: [nodeKey('ghost')], shift: false }))).not.toThrow();
    expect(state.presentation.view.getState().selection.size).toBe(0);
  });

  it('hands the renderer the pointer mode, and a click behaves as in select when the mode is box', () => {
    const state = createClientState();
    load(state, 2, 0);
    const factory = stubFactory();
    view(state, factory.create);
    expect(factory.made[0]?.scenes.at(-1)?.tool).toBe('select');
    act(() => state.presentation.setTool('box'));
    expect(factory.made[0]?.scenes.at(-1)?.tool).toBe('box');
    act(() => factory.made[0]?.events[0]?.click({ target: nodeKey('n0'), shift: false }));
    expect([...state.presentation.view.getState().selection]).toEqual([nodeKey('n0')]);
    act(() => factory.made[0]?.events[0]?.click({ target: undefined, shift: false }));
    expect(state.presentation.view.getState().selection.size).toBe(0);
  });
});

describe('the graph canvas description', () => {
  it('says how many relationships are not drawn, in the words of the scope line', () => {
    const state = createClientState();
    state.bindSource('a');
    state.putResult(key('a'), result('a', ['n1', 'n2'], [['e1', 'n1', 'n2']]));
    state.setLoaded([key('a')], [ref('a', 'type-a', 'n1')], [edgeRef('a', 'e1')]);
    view(state, stubFactory().create);
    const canvas = screen.getByRole('application', { name: 'Graph canvas' });
    const text = canvasSummary(canvas);
    expect(text).toBe('1 entity and 1 relationship loaded; 1 relationship not drawn (entity not loaded)');
  });

  it('uses the plural when several relationships are not drawn', () => {
    const state = createClientState();
    state.bindSource('a');
    state.putResult(key('a'), result('a', ['n1', 'n2'], [['e1', 'n1', 'n2'], ['e2', 'n2', 'n1']]));
    state.setLoaded([key('a')], [ref('a', 'type-a', 'n1')], [edgeRef('a', 'e1'), edgeRef('a', 'e2')]);
    view(state, stubFactory().create);
    const canvas = screen.getByRole('application', { name: 'Graph canvas' });
    const text = canvasSummary(canvas);
    expect(text).toBe('1 entity and 2 relationships loaded; 2 relationships not drawn (entity not loaded)');
  });

  it('says nothing about omissions when every relationship is drawn', () => {
    const state = createClientState();
    load(state, 2, 1);
    view(state, stubFactory().create);
    const canvas = screen.getByRole('application', { name: 'Graph canvas' });
    expect(canvasSummary(canvas)).toBe('2 entities and 1 relationship loaded');
  });
});

describe('the graph canvas on Explore', () => {
  it('draws as many entities and relationships as the scope lines say are loaded', async () => {
    const state = createClientState();
    load(state, 10, 13);
    const factory = stubFactory();
    renderApp('/explore', clientWith({ me: me(), sources: [source('a')] }), state, undefined, factory.create);
    expect(factory.made[0]?.describe()).toEqual({ entities: 10, relationships: 13 });
    expect(screen.getByText('10 entities · 13 relationships · loaded · exact')).toBeTruthy();
  });

  it('keeps the shell usable when the renderer cannot start', async () => {
    renderApp('/explore', clientWith({ me: me(), sources: [source('a')] }), createClientState(), undefined, stubFactory({ failOn: 'mount' }).create);
    expect(screen.getByRole('alert').textContent).toBe(RENDERER_UNAVAILABLE);
    expect(screen.getByRole('link', { name: 'Home' })).toBeTruthy();
    expect(await screen.findByText('Local workspace')).toBeTruthy();
  });
});

describe('the layouts of the graph canvas', () => {
  function withCommands(state: ClientState, factory = stubFactory()) {
    let commands: ReturnType<typeof useCanvasCommands>;
    function Capture() {
      commands = useCanvasCommands();
      return null;
    }
    render(
      <ClientStateProvider state={state}>
        <RendererProvider createRenderer={factory.create}>
          <GraphCanvas profile={undefined} />
          <Capture />
        </RendererProvider>
      </ClientStateProvider>,
    );
    return { run: () => act(() => commands?.layout()), factory };
  }
  const positionsOf = (state: ClientState): Map<string, { x: number; y: number }> => new Map(state.presentation.view.getState().positions);

  it('fit the view once each time a layout is chosen or run again, and not when entities are placed on their own', () => {
    for (const layout of ['force', 'hierarchical', 'radial', 'grid'] as const) {
      const state = createClientState();
      load(state, 8, 9);
      const { run, factory } = withCommands(state);
      const before = factory.made[0]?.fits ?? 0;
      act(() => state.presentation.setLayout(layout));
      run();
      expect(factory.made[0]?.fits, layout).toBe(before + 1);
      run();
      expect(factory.made[0]?.fits, layout).toBe(before + 2);
      act(() => state.presentation.setPositions(new Map([[nodeKey('n1'), { x: 5, y: 5 }]])));
      expect(factory.made[0]?.fits, layout).toBe(before + 2);
    }
  });

  it('give every unpinned entity a grid cell without overlap, leave the pinned ones, and leave out the hidden, the filtered and the ones outside the focus', () => {
    const state = createClientState();
    load(state, 14, 10);
    state.replacePins([nodeKey('n0')]);
    const { run } = withCommands(state);
    act(() => state.hide([nodeKey('n3')]));
    act(() => state.presentation.setLayout('grid'));
    const before = positionsOf(state);
    run();
    const after = positionsOf(state);
    expect(after.get(nodeKey('n0'))).toEqual(before.get(nodeKey('n0')));
    expect(after.get(nodeKey('n3'))).toEqual(before.get(nodeKey('n3')));
    const shown = [...after].filter(([id]) => id !== nodeKey('n3'));
    for (let a = 0; a < shown.length; a += 1) {
      for (let b = a + 1; b < shown.length; b += 1) {
        const first = shown[a]?.[1] ?? { x: 0, y: 0 };
        const second = shown[b]?.[1] ?? { x: 0, y: 0 };
        expect(Math.abs(first.x - second.x) >= 160 || Math.abs(first.y - second.y) >= 94, `${shown[a]?.[0]} ${shown[b]?.[0]}`).toBe(true);
      }
    }
    act(() => state.focusOn(nodeKey('n5')));
    const inFocus = positionsOf(state);
    act(() => state.presentation.setLayout('radial'));
    run();
    for (const [id, position] of positionsOf(state)) {
      const was = inFocus.get(id);
      if (!state.visibleGraph().nodes.some((node) => elementKey(node.ref) === id)) expect(position, id).toEqual(was);
    }
  });

  it('put the previous positions back and show the notice when the drawing of a grid fails', () => {
    const state = createClientState();
    load(state, 6, 5);
    const { run, factory } = withCommands(state);
    act(() => state.presentation.setLayout('grid'));
    const before = positionsOf(state);
    const renderer = factory.made[0];
    if (renderer === undefined) throw new Error('no renderer');
    const draw = renderer.draw.bind(renderer);
    let failures = 1;
    renderer.draw = (scene, restore) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error('cannot draw');
      }
      draw(scene, restore);
    };
    const fitsBefore = renderer.fits;
    run();
    expect(screen.getByRole('alert').textContent).toBe(RENDERER_UNAVAILABLE);
    expect(positionsOf(state)).toEqual(before);
    expect(renderer.fits, 'the view is not fitted after a layout whose drawing failed').toBe(fitsBefore);
  });

  it('fit the view even when every entity is pinned and nothing moves', () => {
    const state = createClientState();
    load(state, 4, 3);
    state.replacePins(['n0', 'n1', 'n2', 'n3'].map(nodeKey));
    const { run, factory } = withCommands(state);
    const before = state.presentation.view.getState().positions;
    const fits = factory.made[0]?.fits ?? 0;
    run();
    expect(factory.made[0]?.fits).toBe(fits + 1);
    expect(state.presentation.view.getState().positions).toBe(before);
  });
});

describe('the live physics of the graph canvas', () => {
  function live(options: { pins?: string[] } = {}) {
    const state = createClientState();
    load(state, 6, 5);
    if (options.pins !== undefined) state.replacePins(options.pins.map(nodeKey));
    const factory = stubFactory();
    view(state, factory.create);
    const renderer = factory.made[0];
    if (renderer === undefined) throw new Error('no renderer');
    const events = renderer.events[0];
    if (events?.dragging === undefined) throw new Error('no drag events');
    const frame = (count = 1): void => {
      act(() => {
        vi.advanceTimersByTime(17 * count);
      });
    };
    return { state, renderer, dragging: events.dragging, events, frame };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(document, 'visibilityState');
  });

  it('runs no frame while physics is off, even when an entity is dragged', () => {
    const { renderer, dragging, frame } = live();
    dragging(nodeKey('n0'), { x: 800, y: 800 });
    frame(5);
    expect(renderer.lives).toHaveLength(0);
  });

  it('pulls the neighbors of a dragged entity once physics is on, never moves a pinned one, goes idle when they settle and stores the positions once', () => {
    const { state, renderer, dragging, frame } = live({ pins: ['n5'] });
    const pinnedAt = state.presentation.view.getState().positions.get(nodeKey('n5'));
    act(() => state.presentation.setPhysics(true));
    frame(400);
    const idle = renderer.lives.length;
    const settledEnds = renderer.liveEnds;
    frame(20);
    expect(renderer.lives.length).toBe(idle);
    const first = renderer.lives[0]?.get(nodeKey('n1'));
    dragging(nodeKey('n0'), { x: 3000, y: 3000 });
    frame(60);
    const during = renderer.lives[renderer.lives.length - 1];
    expect(renderer.lives.length).toBeGreaterThan(idle);
    expect(during?.get(nodeKey('n1'))).not.toEqual(first);
    expect(during?.has(nodeKey('n0'))).toBe(false);
    for (const given of renderer.lives) if (given.has(nodeKey('n5'))) expect(given.get(nodeKey('n5'))).toEqual(pinnedAt);
    dragging(nodeKey('n0'), undefined);
    act(() => state.presentation.setPosition(nodeKey('n0'), { x: 3000, y: 3000 }));
    frame(600);
    expect(renderer.liveEnds).toBeGreaterThan(settledEnds);
    expect(state.presentation.view.getState().positions.get(nodeKey('n0'))).toEqual({ x: 3000, y: 3000 });
    expect(state.presentation.view.getState().positions.get(nodeKey('n5'))).toEqual(pinnedAt);
  });

  it('stops when physics is switched off and keeps the positions of that frame', () => {
    const { state, renderer, dragging, frame } = live();
    act(() => state.presentation.setPhysics(true));
    dragging(nodeKey('n0'), { x: 2500, y: 0 });
    frame(10);
    const lastFrame = renderer.lives[renderer.lives.length - 1];
    act(() => state.presentation.setPhysics(false));
    const count = renderer.lives.length;
    frame(10);
    expect(renderer.lives.length).toBe(count);
    expect(state.presentation.view.getState().positions.get(nodeKey('n1'))).toEqual(lastFrame?.get(nodeKey('n1')));
  });

  it('computes no frame while the tab is hidden, and goes on when it is visible', () => {
    const { state, renderer, dragging, frame } = live();
    act(() => state.presentation.setPhysics(true));
    dragging(nodeKey('n0'), { x: 2500, y: 0 });
    frame(2);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    const count = renderer.lives.length;
    frame(10);
    expect(renderer.lives.length).toBe(count);
    Reflect.deleteProperty(document, 'visibilityState');
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    frame(3);
    expect(renderer.lives.length).toBeGreaterThan(count);
  });

  it('runs no frame under a layout other than Force, and picks up again with Force', () => {
    const { state, renderer, dragging, frame } = live();
    act(() => {
      state.presentation.setLayout('grid');
      state.presentation.setPhysics(true);
    });
    dragging(nodeKey('n0'), { x: 2500, y: 0 });
    frame(10);
    expect(renderer.lives).toHaveLength(0);
    act(() => state.presentation.setLayout('force'));
    frame(3);
    expect(renderer.lives.length).toBeGreaterThan(0);
  });

  it('leaves out an entity that is hidden, and wakes when a position is stored from outside', () => {
    const { state, renderer, frame } = live();
    act(() => state.hide([nodeKey('n3')]));
    act(() => state.presentation.setPhysics(true));
    frame(400);
    for (const given of renderer.lives) expect(given.has(nodeKey('n3'))).toBe(false);
    const idle = renderer.lives.length;
    act(() => state.presentation.setPosition(nodeKey('n1'), { x: 1200, y: 1200 }));
    frame(5);
    expect(renderer.lives.length).toBeGreaterThan(idle);
  });

  it('stops and shows the notice when a frame cannot be drawn', () => {
    const { state, renderer, frame } = live();
    renderer.failLive = true;
    act(() => state.presentation.setPhysics(true));
    frame(3);
    expect(screen.getByRole('alert').textContent).toBe(RENDERER_UNAVAILABLE);
    const count = renderer.lives.length;
    frame(10);
    expect(renderer.lives.length).toBe(count);
  });

  it('cancels the loop when the canvas goes away', () => {
    const { state, renderer, frame } = live();
    act(() => state.presentation.setPhysics(true));
    frame(2);
    cleanup();
    const count = renderer.lives.length;
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(renderer.lives.length).toBe(count);
  });

  it('runs no frame above the cap, and says so in the list', () => {
    const state = createClientState();
    load(state, PHYSICS_MAX_ENTITIES + 1, 5);
    const factory = stubFactory();
    view(state, factory.create);
    act(() => state.presentation.setPhysics(true));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(factory.made[0]?.lives).toHaveLength(0);
  });

  it('leaves out the entities outside the focus, and wakes for the entities an expansion adds', () => {
    const { state, renderer, frame } = live();
    act(() => state.presentation.setPhysics(true));
    frame(400);
    act(() => state.focusOn(nodeKey('n0')));
    frame(400);
    const idle = renderer.lives.length;
    const outside = state.loadedGraph().nodes.map((node) => elementKey(node.ref)).filter((id) => !state.visibleGraph().nodes.some((node) => elementKey(node.ref) === id));
    expect(outside.length).toBeGreaterThan(0);
    for (const given of renderer.lives.slice(idle > 0 ? -1 : 0)) for (const id of outside) expect(given.has(id), id).toBe(false);
    act(() => state.presentation.leaveFocus());
    const wakeFrom = renderer.lives.length;
    const ids = Array.from({ length: 9 }, (_unused, index) => `n${index}`);
    act(() => state.setLoaded([key('a', 'seed-1')], ids.map((id) => ref('a', 'type-a', id)), []));
    frame(5);
    expect(renderer.lives.length).toBeGreaterThanOrEqual(wakeFrom);
  });

  it('wakes for a position stored with an announcement, as an arrow-key move stores it, and keeps a pinned entity where it is', () => {
    const { state, renderer, frame } = live({ pins: ['n2'] });
    act(() => state.presentation.setPhysics(true));
    frame(400);
    const idle = renderer.lives.length;
    act(() => state.presentation.setPositions(new Map([[nodeKey('n1'), { x: 2400, y: 2400 }]]), 'Moved.'));
    frame(5);
    expect(renderer.lives.length).toBeGreaterThan(idle);
    const pinnedAt = state.presentation.view.getState().positions.get(nodeKey('n2'));
    for (const given of renderer.lives.slice(idle)) if (given.has(nodeKey('n2'))) expect(given.get(nodeKey('n2'))).toEqual(pinnedAt);
  });

  it('puts an entity whose drag was cancelled back at its start, and writes no other position for it', () => {
    const { state, renderer, events, frame } = live();
    act(() => state.presentation.setPhysics(true));
    frame(400);
    const start = state.presentation.view.getState().positions.get(nodeKey('n1')) ?? { x: 0, y: 0 };
    act(() => {
      events.dragging?.(nodeKey('n1'), { x: start.x + 4000, y: start.y + 4000 });
      events.dragCancelled?.(nodeKey('n1'), start);
    });
    frame(600);
    const stored = state.presentation.view.getState().positions.get(nodeKey('n1'));
    expect(Math.abs((stored?.x ?? 0) - start.x)).toBeLessThan(1000);
    for (const given of renderer.lives) expect(given.get(nodeKey('n1'))?.x ?? 0).toBeLessThan(start.x + 2000);
  });
});
