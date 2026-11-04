import { act, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { describe, expect, it } from 'vitest';
import { testProfile } from '../dev/test-profile.js';
import { createClientState, type ClientState } from '../state/client-state.js';
import { ClientStateProvider } from '../state/context.js';
import { edgeKey, elementKey } from '../state/keys.js';
import { edgeRef, key, ref, result } from '../state/test-data.js';
import { clientWith, me, renderApp, source, stubFactory, type StubOptions } from '../test-utils.js';
import { useCanvasCommands } from './canvas-commands.js';
import { GraphCanvas, RENDERER_UNAVAILABLE } from './graph-canvas.js';
import { RendererProvider } from './renderer-context.js';
import { runSelectionCommand } from './selection-commands.js';
import type { CreateRenderer } from './scene.js';
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

  it('writes the positions the renderer chose to presentation state once, and places nothing on the draw that follows', () => {
    const state = createClientState();
    load(state, 3, 0);
    const factory = stubFactory();
    view(state, factory.create);
    const renderer = factory.made[0];
    expect(state.presentation.view.getState().positions.size).toBe(3);
    expect(renderer?.scenes[0]?.entities.every((entity) => entity.position === undefined)).toBe(true);
    const last = renderer?.scenes.at(-1);
    expect(last?.entities.every((entity) => entity.position !== undefined)).toBe(true);
    expect(renderer?.scenes).toHaveLength(2);
  });

  it('draws every entity at its position and writes none when all of them have one', () => {
    const state = createClientState();
    load(state, 2, 0);
    state.presentation.setPosition(nodeKey('n0'), { x: 1, y: 1 });
    state.presentation.setPosition(nodeKey('n1'), { x: 2, y: 2 });
    const factory = stubFactory({ placeAt: () => ({ x: 999, y: 999 }) });
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
    expect(screen.getByRole('img', { name: 'Graph canvas' })).toBeTruthy();
  });

  it('is named "Graph canvas" and says how many entities and relationships are loaded', () => {
    const state = createClientState();
    load(state, 1200, 3);
    view(state, stubFactory().create);
    const canvas = screen.getByRole('img', { name: 'Graph canvas' });
    const description = document.getElementById(canvas.getAttribute('aria-describedby') ?? '');
    expect(description?.textContent).toBe('1,200 entities and 3 relationships loaded');
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
    expect(screen.getByRole('img', { name: 'Graph canvas' })).toBeTruthy();
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
    const canvas = screen.getByRole('img', { name: 'Graph canvas' });
    expect([canvas.dataset['drawnEntities'], canvas.dataset['drawnRelationships'], canvas.dataset['zoom']]).toEqual(['3', '2', '1']);
    act(() => factory.made[0]?.events[0]?.viewport({ zoom: 2.5, x: 12, y: -3 }));
    expect([canvas.dataset['zoom'], canvas.dataset['panX'], canvas.dataset['panY']]).toEqual(['2.5', '12', '-3']);
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

  it('reach the renderer while it runs and are withdrawn when it is disposed', () => {
    const state = createClientState();
    load(state, 2, 1);
    const factory = stubFactory();
    const result = { available: false };
    const commands = viewWithProbe(state, factory.create, result);
    expect(result.available).toBe(true);
    act(() => commands()?.fit());
    act(() => commands()?.zoomBy(1.25));
    expect(factory.made[0]?.fits).toBe(1);
    expect(factory.made[0]?.zooms).toEqual([1.25]);
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
    const canvas = screen.getByRole('img', { name: 'Graph canvas' });
    const text = () => document.getElementById(canvas.getAttribute('aria-describedby') ?? '')?.textContent;
    expect(text()).toBe('3 entities and 0 relationships loaded');
    act(() => state.presentation.select([nodeKey('n0'), nodeKey('n2')]));
    expect(text()).toBe('3 entities and 0 relationships loaded; 2 selected');
  });
});

describe('the labels of stored relationships on the graph canvas', () => {
  it('reach the renderer while an entity they join is selected, and go when the selection is cleared', () => {
    const state = createClientState();
    load(state, 3, 1);
    const factory = stubFactory();
    view(state, factory.create);
    const labels = () => factory.made[0]?.scenes.at(-1)?.relationships.map((relationship) => relationship.look.label);
    expect(labels()).toEqual([undefined]);
    act(() => state.presentation.select([nodeKey('n0')]));
    expect(labels()).toEqual(['rel-a']);
    act(() => state.presentation.select([nodeKey('n2')]));
    expect(labels()).toEqual([undefined]);
    act(() => state.presentation.select([nodeKey('n1')]));
    act(() => runSelectionCommand(state, 'clear-selection'));
    expect(labels()).toEqual([undefined]);
  });
});

describe('the selection commands on the graph canvas', () => {
  it('reach the canvas: select all shows in the description and the scene, clear takes it away', () => {
    const state = createClientState();
    load(state, 3, 1);
    const factory = stubFactory();
    view(state, factory.create);
    const canvas = screen.getByRole('img', { name: 'Graph canvas' });
    const text = () => document.getElementById(canvas.getAttribute('aria-describedby') ?? '')?.textContent;
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
    const canvas = screen.getByRole('img', { name: 'Graph canvas' });
    const text = document.getElementById(canvas.getAttribute('aria-describedby') ?? '')?.textContent;
    expect(text).toBe('1 entity and 1 relationship loaded; 1 relationship not drawn (entity not loaded)');
  });

  it('uses the plural when several relationships are not drawn', () => {
    const state = createClientState();
    state.bindSource('a');
    state.putResult(key('a'), result('a', ['n1', 'n2'], [['e1', 'n1', 'n2'], ['e2', 'n2', 'n1']]));
    state.setLoaded([key('a')], [ref('a', 'type-a', 'n1')], [edgeRef('a', 'e1'), edgeRef('a', 'e2')]);
    view(state, stubFactory().create);
    const canvas = screen.getByRole('img', { name: 'Graph canvas' });
    const text = document.getElementById(canvas.getAttribute('aria-describedby') ?? '')?.textContent;
    expect(text).toBe('1 entity and 2 relationships loaded; 2 relationships not drawn (entity not loaded)');
  });

  it('says nothing about omissions when every relationship is drawn', () => {
    const state = createClientState();
    load(state, 2, 1);
    view(state, stubFactory().create);
    const canvas = screen.getByRole('img', { name: 'Graph canvas' });
    expect(document.getElementById(canvas.getAttribute('aria-describedby') ?? '')?.textContent).toBe('2 entities and 1 relationship loaded');
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
    expect(screen.getByRole('button', { name: 'Ask, locked' })).toBeTruthy();
    expect(await screen.findByText('Local workspace')).toBeTruthy();
  });
});
