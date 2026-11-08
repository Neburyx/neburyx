import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCytoscapeRenderer, type RendererCore as Core } from './cytoscape-renderer.js';
import { pinBadgeUri } from './pin-badge.js';
import { glyphUri } from './glyphs.js';
import { CAPTION_MIN_ZOOM, FIT_PADDING, GLYPH_COLOR } from './look.js';
import { FIT_ZOOM_MAX, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP } from './zoom.js';
import type { CanvasEvents, RightClick, Scene } from './scene.js';
import type { BoxSelection } from './box-selection.js';
import type { Click } from './selection-gestures.js';
import type { Viewport } from '../state/presentation-state.js';
import { stubCanvasContext, stubSizeObserver } from '../test-utils.js';

function scene(entities: ReadonlyArray<readonly [string, { x: number; y: number }]>, relationships: ReadonlyArray<readonly [string, string, string]> = []): Scene {
  return {
    entities: entities.map(([id, position]) => ({ id, position, look: { iconKey: 'generic' as const, line1: id, line2: 'Type' } })),
    relationships: relationships.map(([id, from, to]) => ({ id, from, to, look: { aggregate: false, origin: 'stored' as const, label: undefined } })),
    profile: undefined,
    omitted: 0, selection: new Set<string>(), pinned: new Set<string>(), tool: 'select' as const, source: null,
    view: 'fit' as const,
  };
}

// The painter stops a frame after 4 ms of the real clock, so a test that expects the captions of a frame to be painted would depend on how busy the machine is; the clock stands still unless a test moves it.
beforeEach(() => void vi.spyOn(performance, 'now').mockReturnValue(0));
afterEach(() => vi.restoreAllMocks());

const NO_EVENTS: CanvasEvents = { viewport: () => undefined, click: () => undefined, box: () => undefined, contextMenu: () => undefined, move: () => undefined, failed: () => undefined };

function mounted(events: CanvasEvents = NO_EVENTS) {
  const renderer = createCytoscapeRenderer({ nextFrame: (callback) => callback() });
  renderer.mount(undefined, events, undefined);
  return renderer;
}

describe('the Cytoscape renderer', () => {
  it('draws one entity and one relationship for each of the scene, and says so', () => {
    const renderer = mounted();
    renderer.draw(scene([['a', { x: 0, y: 0 }], ['b', { x: 100, y: 0 }], ['c', { x: 0, y: 100 }]], [['ab', 'a', 'b'], ['bc', 'b', 'c']]));
    expect(renderer.describe()).toEqual({ entities: 3, relationships: 2 });
  });

  it('draws parallel relationships between the same two entities as separate lines', () => {
    const renderer = mounted();
    renderer.draw(scene([['a', { x: 0, y: 0 }], ['b', { x: 100, y: 0 }]], [['one', 'a', 'b'], ['two', 'a', 'b'], ['three', 'b', 'a']]));
    expect(renderer.describe().relationships).toBe(3);
  });

  it('draws every entity exactly where the scene puts it, and never moves one on its own', () => {
    let core: Core | undefined;
    const renderer = createCytoscapeRenderer({ nextFrame: (callback) => callback(), onCore: (made) => void (core = made) });
    renderer.mount(undefined, NO_EVENTS, undefined);
    const entities: ReadonlyArray<readonly [string, { x: number; y: number }]> = [['a', { x: 10, y: 20 }], ['b', { x: -300, y: 7.5 }], ['c', { x: 0, y: 0 }]];
    const links: ReadonlyArray<readonly [string, string, string]> = [['ab', 'a', 'b'], ['ac', 'a', 'c']];
    const at = () => Object.fromEntries(entities.map(([id]) => [id, core?.getElementById(id).position()]));
    renderer.draw(scene(entities, links));
    expect(at()).toEqual({ a: { x: 10, y: 20 }, b: { x: -300, y: 7.5 }, c: { x: 0, y: 0 } });
    renderer.draw(scene(entities, links));
    renderer.draw(scene([...entities, ['d', { x: 500, y: 500 }]], [...links, ['ad', 'a', 'd']]));
    expect(at()).toEqual({ a: { x: 10, y: 20 }, b: { x: -300, y: 7.5 }, c: { x: 0, y: 0 } });
    expect(core?.getElementById('d').position()).toEqual({ x: 500, y: 500 });
  });

  it('draws a position that differs from the one it drew before', () => {
    let core: Core | undefined;
    const renderer = createCytoscapeRenderer({ nextFrame: (callback) => callback(), onCore: (made) => void (core = made) });
    renderer.mount(undefined, NO_EVENTS, undefined);
    renderer.draw(scene([['a', { x: 0, y: 0 }], ['b', { x: 40, y: 0 }]]));
    renderer.draw(scene([['a', { x: 0, y: 0 }], ['b', { x: -70, y: 33 }]]));
    expect(core?.getElementById('a').position()).toEqual({ x: 0, y: 0 });
    expect(core?.getElementById('b').position()).toEqual({ x: -70, y: 33 });
  });

  it('runs no layout of its own: the library is never asked for one', () => {
    let core: Core | undefined;
    const renderer = createCytoscapeRenderer({ nextFrame: (callback) => callback(), onCore: (made) => void (core = made) });
    renderer.mount(undefined, NO_EVENTS, undefined);
    let layouts = 0;
    const original = core?.layout.bind(core);
    if (core !== undefined && original !== undefined) core.layout = (...given: Parameters<Core['layout']>) => { layouts += 1; return original(...given); };
    renderer.draw(scene([['a', { x: 0, y: 0 }], ['b', { x: 100, y: 0 }], ['c', { x: 0, y: 100 }]], [['ab', 'a', 'b'], ['bc', 'b', 'c']]));
    renderer.draw(scene([['a', { x: 0, y: 0 }], ['b', { x: 100, y: 0 }], ['c', { x: 0, y: 100 }], ['d', { x: 9, y: 9 }]], [['ab', 'a', 'b'], ['bc', 'b', 'c'], ['cd', 'c', 'd']]));
    expect(layouts).toBe(0);
  });

  it('keeps one instance across draws, adds what is new and removes what is gone with its relationships', () => {
    const renderer = mounted();
    renderer.draw(scene([['a', { x: 0, y: 0 }], ['b', { x: 50, y: 0 }]], [['ab', 'a', 'b']]));
    renderer.draw(scene([['a', { x: 0, y: 0 }], ['c', { x: 0, y: 50 }]], [['ac', 'a', 'c']]));
    expect(renderer.describe()).toEqual({ entities: 2, relationships: 1 });
  });

  it('moves an entity whose position changed', () => {
    const renderer = mounted();
    renderer.draw(scene([['a', { x: 0, y: 0 }]]));
    renderer.draw(scene([['a', { x: 5, y: 6 }]]));
    expect(renderer.describe().entities).toBe(1);
  });

  it('refuses to draw before it is mounted and to be mounted twice, and can be disposed and mounted again', () => {
    const renderer = createCytoscapeRenderer();
    expect(() => renderer.draw(scene([]))).toThrow('not mounted');
    renderer.mount(undefined, NO_EVENTS, undefined);
    expect(() => renderer.mount(undefined, NO_EVENTS, undefined)).toThrow('already mounted');
    renderer.dispose();
    expect(() => renderer.describe()).toThrow('not mounted');
    renderer.mount(undefined, NO_EVENTS, undefined);
    expect(renderer.describe()).toEqual({ entities: 0, relationships: 0 });
  });
});

describe('the drawing of an investigation that was set aside and comes back', () => {
  const first = { ...scene([['a', { x: 0, y: 0 }], ['b', { x: 400, y: 300 }]]), source: 'one' };
  const second = { ...scene([['c', { x: 50, y: 50 }]]), source: 'two' };
  const held: Viewport = { zoom: 2.5, x: -120, y: 33 };
  const started = () => {
    const renderer = createCytoscapeRenderer({ nextFrame: (callback) => callback(), canvasSize: () => ({ width: 1000, height: 800 }) });
    renderer.mount(undefined, NO_EVENTS, undefined);
    return renderer;
  };

  it('shows the viewport it was left with, instead of fitting, when another source was drawn in between', () => {
    const renderer = started();
    renderer.draw(first);
    renderer.draw(second);
    const fitsBefore = renderer.inspect().fits;
    renderer.draw(first, held);
    expect(renderer.viewport()).toEqual(held);
    expect(renderer.inspect().fits).toBe(fitsBefore);
  });

  it('shows the viewport it was left with when every entity of a drawing of the same source was replaced', () => {
    const renderer = started();
    renderer.draw({ ...first, source: 'same' });
    renderer.draw({ ...second, source: 'same' });
    renderer.draw({ ...first, source: 'same' }, held);
    expect(renderer.viewport()).toEqual(held);
  });

  it('fits a drawing that has no viewport to come back to', () => {
    const renderer = started();
    renderer.draw(first);
    renderer.draw(second);
    const fitsBefore = renderer.inspect().fits;
    renderer.draw(first, undefined);
    expect(renderer.inspect().fits).toBe(fitsBefore + 1);
    expect(renderer.viewport()).not.toEqual(held);
  });

  it('leaves the viewport alone on a draw that does not start a new drawing, whatever viewport it is given', () => {
    const renderer = started();
    renderer.draw(first);
    const shown = renderer.viewport();
    renderer.draw({ ...first, selection: new Set(['a']) }, held);
    expect(renderer.viewport()).toEqual(shown);
  });
});

describe('the entities the Cytoscape renderer draws', () => {
  const look = (iconKey: 'generic' | 'money', line1: string, line2: string) => ({ iconKey, line1, line2 });
  const one = (position: { x: number; y: number }, entityLook = look('money', 'ACC-1', 'Alpha · Open')): Scene => ({ entities: [{ id: 'a', position, look: entityLook }], relationships: [], profile: undefined, omitted: 0, selection: new Set<string>(), pinned: new Set<string>(), tool: 'select' as const, source: null, view: 'fit' as const });

  it('draws a disc 36 px across its 1 px outline, the glyph of its icon key and the caption its look names', () => {
    const painted: string[] = [];
    const renderer = createCytoscapeRenderer({ nextFrame: (callback) => callback(), paintCaption: (line1, line2) => { painted.push(`${line1}|${line2}`); return 'data:image/png;base64,AAAA'; } });
    renderer.mount(undefined, NO_EVENTS, undefined);
    renderer.draw(one({ x: 0, y: 0 }));
    const [node] = renderer.inspect().nodes;
    expect(node?.diameter).toBe(35);
    expect((node?.diameter ?? 0) + 1).toBe(36);
    expect(node?.images).toEqual([glyphUri('money', GLYPH_COLOR), 'data:image/png;base64,AAAA']);
    expect(node?.caption).toBe('ACC-1\nAlpha · Open');
    expect(painted).toEqual(['ACC-1|Alpha · Open']);
  });

  it('adds the pin badge as the last image of a pinned entity, after the glyph and the caption, and none to an unpinned one', () => {
    const renderer = createCytoscapeRenderer({ nextFrame: (callback) => callback(), paintCaption: () => 'data:image/png;base64,AAAA' });
    renderer.mount(undefined, NO_EVENTS, undefined);
    const both: Scene = { ...one({ x: 0, y: 0 }), entities: [{ id: 'a', position: { x: 0, y: 0 }, look: look('money', 'ACC-1', 'Alpha · Open') }, { id: 'b', position: { x: 90, y: 0 }, look: look('money', 'ACC-2', 'Alpha · Open') }], pinned: new Set(['a']) };
    renderer.draw(both);
    const [pinned, plain] = renderer.inspect().nodes;
    expect(pinned?.images).toEqual([glyphUri('money', GLYPH_COLOR), 'data:image/png;base64,AAAA', pinBadgeUri()]);
    expect(plain?.images).toEqual([glyphUri('money', GLYPH_COLOR), 'data:image/png;base64,AAAA']);
  });

  it('keeps the badge in its own place in the image list while the caption is not painted yet, and puts none in an unpinned entity\'s list', () => {
    const renderer = createCytoscapeRenderer({ nextFrame: () => undefined, paintCaption: () => 'data:image/png;base64,AAAA' });
    renderer.mount(undefined, NO_EVENTS, undefined);
    renderer.draw({ ...one({ x: 0, y: 0 }), entities: [{ id: 'a', position: { x: 0, y: 0 }, look: look('money', 'ACC-1', 'Alpha · Open') }, { id: 'b', position: { x: 90, y: 0 }, look: look('money', 'ACC-2', 'Alpha · Open') }], pinned: new Set(['a']) });
    const [pinned, plain] = renderer.inspect().nodes;
    expect(pinned?.images).toHaveLength(3);
    expect(pinned?.images[2]).toBe(pinBadgeUri());
    expect(pinned?.images[1]).not.toBe(pinBadgeUri());
    expect(plain?.images).toEqual([glyphUri('money', GLYPH_COLOR)]);
  });

  it('adds and takes away the badge when the pin changes, keeping the painted caption and painting nothing again', () => {
    let paints = 0;
    const renderer = createCytoscapeRenderer({ nextFrame: (callback) => callback(), paintCaption: () => { paints += 1; return 'data:image/png;base64,AAAA'; } });
    renderer.mount(undefined, NO_EVENTS, undefined);
    renderer.draw(one({ x: 0, y: 0 }));
    renderer.draw({ ...one({ x: 0, y: 0 }), pinned: new Set(['a']) });
    expect(renderer.inspect().nodes[0]?.images).toEqual([glyphUri('money', GLYPH_COLOR), 'data:image/png;base64,AAAA', pinBadgeUri()]);
    renderer.draw(one({ x: 0, y: 0 }));
    expect(renderer.inspect().nodes[0]?.images).toEqual([glyphUri('money', GLYPH_COLOR), 'data:image/png;base64,AAAA']);
    expect(paints).toBe(1);
  });

  it('paints a caption once however often it is drawn, and again only for another text', () => {
    let paints = 0;
    const renderer = createCytoscapeRenderer({ nextFrame: (callback) => callback(), paintCaption: () => { paints += 1; return 'data:image/png;base64,AAAA'; } });
    renderer.mount(undefined, NO_EVENTS, undefined);
    renderer.draw(one({ x: 0, y: 0 }));
    renderer.draw(one({ x: 0, y: 0 }));
    renderer.draw({ entities: [{ id: 'a', position: { x: 0, y: 0 }, look: look('money', 'ACC-1', 'Alpha · Open') }, { id: 'b', position: { x: 90, y: 0 }, look: look('money', 'ACC-1', 'Alpha · Open') }], relationships: [], profile: undefined, omitted: 0, selection: new Set<string>(), pinned: new Set<string>(), tool: 'select' as const, source: null, view: 'fit' as const });
    expect(paints).toBe(1);
    renderer.draw(one({ x: 0, y: 0 }, look('generic', 'ACC-1', 'Alpha · Closed')));
    expect(paints).toBe(2);
  });

  it('changes the glyph and the caption when the look changes, without moving the entity', () => {
    const renderer = createCytoscapeRenderer({ nextFrame: (callback) => callback(), paintCaption: (line1) => `data:image/png;base64,${btoa(line1)}` });
    renderer.mount(undefined, NO_EVENTS, undefined);
    renderer.draw(one({ x: 11, y: 22 }, look('generic', 'ACC-1', 'type-a')));
    const first = renderer.inspect().nodes[0];
    renderer.draw(one({ x: 11, y: 22 }, look('money', 'ACC-1', 'Alpha')));
    const second = renderer.inspect().nodes[0];
    expect(first?.images[0]).toBe(glyphUri('generic', GLYPH_COLOR));
    expect(second?.images[0]).toBe(glyphUri('money', GLYPH_COLOR));
    expect(second?.caption).toBe('ACC-1\nAlpha');
  });

  describe('whose captions are painted in the frames that follow', () => {
    const many = (count: number): Scene => ({ entities: Array.from({ length: count }, (_unused, index) => ({ id: `e${index}`, position: { x: index * 200, y: 0 }, look: look('generic', `ID-${index}`, 'Type') })), relationships: [], profile: undefined, omitted: 0, selection: new Set<string>(), pinned: new Set<string>(), tool: 'select' as const, source: null, view: 'fit' as const });

    function frames() {
      const waiting: Array<() => void> = [];
      return { nextFrame: (callback: () => void) => void waiting.push(callback), run: () => waiting.splice(0).forEach((callback) => callback()), pending: () => waiting.length };
    }

    it('draws each entity at once with its glyph and no caption, and paints the captions when the frames come', () => {
      const loop = frames();
      const renderer = createCytoscapeRenderer({ nextFrame: loop.nextFrame, paintCaption: (line1) => `data:image/png;base64,${btoa(line1)}` });
      renderer.mount(undefined, NO_EVENTS, undefined);
      renderer.draw(many(3));
      expect(renderer.inspect().nodes.map((node) => node.images)).toEqual(Array(3).fill([glyphUri('generic', GLYPH_COLOR)]));
      loop.run();
      expect(renderer.inspect().nodes.map((node) => node.images[1])).toEqual([0, 1, 2].map((index) => `data:image/png;base64,${btoa(`ID-${index}`)}`));
      expect(loop.pending()).toBe(0);
    });

    it('paints only as many captions in a frame as the budget of 4 ms allows, and the rest in the frames after', () => {
      const loop = frames();
      let clock = 0;
      const now = vi.spyOn(performance, 'now').mockImplementation(() => clock);
      try {
        const renderer = createCytoscapeRenderer({ nextFrame: loop.nextFrame, paintCaption: (line1) => { clock += 3; return `data:image/png;base64,${btoa(line1)}`; } });
        renderer.mount(undefined, NO_EVENTS, undefined);
        renderer.draw(many(10));
        const painted = () => renderer.inspect().nodes.filter((node) => node.images.length === 2).length;
        loop.run();
        expect(painted()).toBe(2);
        loop.run();
        expect(painted()).toBe(4);
        while (loop.pending() > 0) loop.run();
        expect(painted()).toBe(10);
      } finally {
        now.mockRestore();
      }
    });

    it('paints nothing for an entity that was taken out or whose look changed before its turn, and paints the new look', () => {
      const loop = frames();
      const painted: string[] = [];
      const renderer = createCytoscapeRenderer({ nextFrame: loop.nextFrame, paintCaption: (line1) => { painted.push(line1); return 'data:image/png;base64,AAAA'; } });
      renderer.mount(undefined, NO_EVENTS, undefined);
      renderer.draw(many(3));
      renderer.draw({ ...many(3), entities: [{ id: 'e0', position: { x: 0, y: 0 }, look: look('generic', 'ID-0', 'Changed') }, { id: 'e2', position: { x: 400, y: 0 }, look: look('generic', 'ID-2', 'Type') }] });
      loop.run();
      expect(painted.sort()).toEqual(['ID-0', 'ID-2']);
      expect(renderer.describe().entities).toBe(2);
    });

    it('does nothing when the frame comes after the renderer was disposed', () => {
      const loop = frames();
      const painted: string[] = [];
      const renderer = createCytoscapeRenderer({ nextFrame: loop.nextFrame, paintCaption: (line1) => { painted.push(line1); return 'data:image/png;base64,AAAA'; } });
      renderer.mount(undefined, NO_EVENTS, undefined);
      renderer.draw(many(3));
      renderer.dispose();
      expect(() => loop.run()).not.toThrow();
      expect(painted).toEqual([]);
    });
  });

  it('draws no images when there is no drawing surface and no painter', () => {
    const renderer = createCytoscapeRenderer();
    renderer.mount(undefined, NO_EVENTS, undefined);
    renderer.draw(one({ x: 0, y: 0 }));
    expect(renderer.inspect().nodes[0]?.images).toEqual([]);
  });
});

describe('the relationships the Cytoscape renderer draws', () => {
  const rgb = (hex: string): string => `rgb(${[1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)).join(',')})`;
  const look = (aggregate: boolean, origin: 'stored' | 'derived' | 'unknown', label: string | undefined) => ({ aggregate, origin, label });
  const two = (relationships: ReadonlyArray<{ id: string; look: ReturnType<typeof look> }>): Scene => ({
    entities: [
      { id: 'a', position: { x: 0, y: 0 }, look: { iconKey: 'generic', line1: 'a', line2: 'T' } },
      { id: 'b', position: { x: 200, y: 0 }, look: { iconKey: 'generic', line1: 'b', line2: 'T' } },
    ],
    relationships: relationships.map((relationship) => ({ id: relationship.id, from: 'a', to: 'b', look: relationship.look })),
    profile: undefined,
    omitted: 0, selection: new Set<string>(), pinned: new Set<string>(), tool: 'select' as const, source: null,
    view: 'fit' as const,
  });
  const drawn = (relationships: ReadonlyArray<{ id: string; look: ReturnType<typeof look> }>) => {
    const renderer = mounted();
    renderer.draw(two(relationships));
    return new Map(renderer.inspect().edges.map((edge) => [edge.id, edge]));
  };

  it('draws a stored relationship as a solid 1.4 px line with an arrow at its target end and no label', () => {
    const edge = drawn([{ id: 's', look: look(false, 'stored', undefined) }]).get('s');
    expect(edge).toMatchObject({ width: 1.4, color: rgb('#8c96a8'), lineStyle: 'solid', arrow: 'chevron', label: '', labelOutline: 0 });
  });

  it('draws a derived relationship as a dashed 1.4 px accent line with no arrow and its label', () => {
    const edge = drawn([{ id: 'd', look: look(false, 'derived', 'T · derived') }]).get('d');
    expect(edge).toMatchObject({ width: 1.4, color: rgb('#5264a7'), lineStyle: 'dashed', arrow: 'none', label: 'T · derived', labelOutline: 0 });
  });

  it('draws an aggregate as a 3.5 px line with an arrow and a pill outlined 1.5 px', () => {
    const edge = drawn([{ id: 'g', look: look(true, 'stored', 'T · 42') }]).get('g');
    expect(edge).toMatchObject({ width: 3.5, color: rgb('#8c96a8'), lineStyle: 'solid', arrow: 'chevron', label: 'T · 42', labelOutline: 1.5 });
  });

  it('draws a relationship of unknown origin as a dotted line with an arrow and its label, and an unknown-origin aggregate with the aggregate width', () => {
    const edges = drawn([{ id: 'u', look: look(false, 'unknown', 'T · origin unknown') }, { id: 'ug', look: look(true, 'unknown', 'T · 42 · origin unknown') }]);
    expect(edges.get('u')).toMatchObject({ width: 1.4, lineStyle: 'dotted', arrow: 'chevron', label: 'T · origin unknown' });
    expect(edges.get('ug')).toMatchObject({ width: 3.5, lineStyle: 'dotted', label: 'T · 42 · origin unknown', labelOutline: 1.5 });
  });

  it('draws a derived aggregate dashed in the accent colour with the aggregate width and no arrow', () => {
    expect(drawn([{ id: 'dg', look: look(true, 'derived', 'T · 42 · derived') }]).get('dg')).toMatchObject({ width: 3.5, color: rgb('#5264a7'), lineStyle: 'dashed', arrow: 'none', labelOutline: 1.5 });
  });

  it('tells the four kinds apart by line style, width and label without colour', () => {
    const edges = drawn([
      { id: 's', look: look(false, 'stored', undefined) },
      { id: 'd', look: look(false, 'derived', 'T · derived') },
      { id: 'g', look: look(true, 'stored', 'T · 42') },
      { id: 'u', look: look(false, 'unknown', 'T · origin unknown') },
    ]);
    const signature = (id: string) => { const edge = edges.get(id); return `${edge?.lineStyle}|${edge?.width}|${edge?.label}`; };
    expect(new Set(['s', 'd', 'g', 'u'].map(signature)).size).toBe(4);
  });

  it('updates the label and style of a relationship that is drawn again with another look', () => {
    const renderer = mounted();
    renderer.draw(two([{ id: 'g', look: look(true, 'stored', 'T · ~42 (estimated)') }]));
    renderer.draw(two([{ id: 'g', look: look(true, 'stored', 'T · 42') }]));
    expect(renderer.inspect().edges[0]?.label).toBe('T · 42');
  });
});

describe('what the Cytoscape renderer lets the pointer do', () => {
  it('lets it pan and zoom, and grab an entity that the scene lets be dragged, and select nothing itself', () => {
    const renderer = mounted();
    expect(renderer.inspect().interaction).toEqual({ panning: true, zooming: true, boxSelecting: false, nodesGrabbable: false, nodesSelectable: false });
    renderer.draw(scene([['a', { x: 0, y: 0 }]]));
    expect(renderer.inspect().interaction).toEqual({ panning: true, zooming: true, boxSelecting: false, nodesGrabbable: true, nodesSelectable: false });
  });
});

type LibraryElement = ReturnType<Core['getElementById']>;

// The library's typings take only an event name; the library itself takes an event object with the pointer's position.
function emitAt(element: LibraryElement, type: string, at: { x: number; y: number }): void {
  // @ts-expect-error the typings of `emit` do not allow an event object
  element.emit({ type, renderedPosition: at });
}

describe('the entity drags of the Cytoscape renderer', () => {
  function rig(options: { readonly canvas?: { readonly width: number; readonly height: number } } = {}) {
    const moves: Array<{ readonly id: string; readonly position: { readonly x: number; readonly y: number } }> = [];
    let core: Core | undefined;
    const renderer = createCytoscapeRenderer({ nextFrame: (callback) => callback(), onCore: (made) => void (core = made), canvasSize: () => options.canvas ?? { width: 1000, height: 800 } });
    renderer.mount(undefined, { ...NO_EVENTS, move: (move) => void moves.push(move) }, undefined);
    const library = (): Core => {
      if (core === undefined) throw new Error('no core');
      return core;
    };
    const entity = (id: string) => library().getElementById(id);
    const grab = (id: string) => entity(id).emit('grab');
    const dragTo = (id: string, x: number, y: number) => {
      entity(id).position({ x, y });
      entity(id).emit('drag');
    };
    const release = (id: string, at = { x: 500, y: 400 }) => {
      emitAt(entity(id), 'dragfree', at);
      entity(id).emit('free');
    };
    return { renderer, moves, entity, grab, dragTo, release, library };
  }
  const withTool = (base: Scene, tool: Scene['tool']): Scene => ({ ...base, tool });
  const withPins = (base: Scene, pinned: readonly string[]): Scene => ({ ...base, pinned: new Set(pinned) });
  const two = (): Scene => scene([['a', { x: 0, y: 0 }], ['b', { x: 300, y: 0 }]], [['ab', 'a', 'b']]);

  it('lets an entity be grabbed in the modes select and box select, and not in pan, and never when it is pinned, whichever mode', () => {
    const { renderer, entity } = rig();
    for (const [tool, pinned, expected] of [['select', [], [true, true]], ['box', [], [true, true]], ['pan', [], [false, false]], ['select', ['a'], [false, true]], ['box', ['a', 'b'], [false, false]], ['pan', ['a'], [false, false]]] as const) {
      renderer.draw(withPins(withTool(two(), tool), pinned));
      expect([entity('a').grabbable(), entity('b').grabbable()], `${tool} with ${pinned.join(',')} pinned`).toEqual(expected);
    }
  });

  it('reports the entity and where it was left, once, when it is released inside the canvas, and nothing for a grab alone', () => {
    const { renderer, moves, grab, dragTo, release } = rig();
    renderer.draw(two());
    grab('a');
    release('a');
    expect(moves).toEqual([]);
    grab('a');
    dragTo('a', 120.5, -40);
    dragTo('a', 130, -45);
    release('a');
    expect(moves).toEqual([{ id: 'a', position: { x: 130, y: -45 } }]);
  });

  it('does not move the entity back on a redraw while it is dragged, and keeps the other entities where the scene puts them', () => {
    const { renderer, grab, dragTo, entity, release, moves } = rig();
    renderer.draw(two());
    grab('a');
    dragTo('a', 77, 88);
    renderer.draw(withTool(two(), 'select'));
    expect(entity('a').position()).toEqual({ x: 77, y: 88 });
    expect(entity('b').position()).toEqual({ x: 300, y: 0 });
    release('a');
    expect(moves).toEqual([{ id: 'a', position: { x: 77, y: 88 } }]);
  });

  it('puts the entity back and reports nothing when it is released outside the canvas', () => {
    const { renderer, grab, dragTo, entity, release, moves } = rig({ canvas: { width: 1000, height: 800 } });
    renderer.draw(two());
    grab('a');
    dragTo('a', 500, 500);
    release('a', { x: 1500, y: 400 });
    expect(entity('a').position()).toEqual({ x: 0, y: 0 });
    expect(moves).toEqual([]);
  });

  it('puts the entity back, reports nothing and keeps it there while the pointer moves on, when the window loses focus', () => {
    const { renderer, grab, dragTo, entity, release, moves } = rig();
    renderer.draw(two());
    grab('a');
    dragTo('a', 50, 60);
    window.dispatchEvent(new Event('blur'));
    expect(entity('a').position()).toEqual({ x: 0, y: 0 });
    dragTo('a', 400, 400);
    expect(entity('a').position()).toEqual({ x: 0, y: 0 });
    release('a');
    expect(moves).toEqual([]);
  });

  it.each([
    ['the mode becomes pan', (scene: Scene) => withTool(scene, 'pan')],
    ['the mode becomes box select', (scene: Scene) => withTool(scene, 'box')],
    ['the entity becomes pinned', (scene: Scene) => withPins(scene, ['a'])],
    ['another entity becomes pinned', (scene: Scene) => withPins(scene, ['b'])],
    ['the source is replaced', (scene: Scene) => ({ ...scene, source: 'another' })],
  ])('puts the entity back and reports nothing when %s during the drag', (_name, change) => {
    const { renderer, grab, dragTo, entity, release, moves } = rig();
    renderer.draw(two());
    grab('a');
    dragTo('a', 90, 90);
    renderer.draw(change(two()));
    expect(entity('a').position()).toEqual({ x: 0, y: 0 });
    dragTo('a', 200, 200);
    release('a');
    expect(moves).toEqual([]);
    expect(entity('a').position()).toEqual({ x: 0, y: 0 });
  });

  it('reports nothing when the entity was taken out during the drag, and nothing throws', () => {
    const { renderer, grab, dragTo, library, moves } = rig();
    renderer.draw(two());
    grab('a');
    dragTo('a', 90, 90);
    renderer.draw(scene([['b', { x: 300, y: 0 }]]));
    expect(() => emitAt(library().getElementById('a'), 'dragfree', { x: 500, y: 400 })).not.toThrow();
    expect(moves).toEqual([]);
  });

  it('reports nothing for a drag that was open when the renderer was disposed, and starts afresh when it is mounted again', () => {
    let core: Core | undefined;
    const moves: string[] = [];
    const renderer = createCytoscapeRenderer({ nextFrame: (callback) => callback(), onCore: (made) => void (core = made), canvasSize: () => ({ width: 1000, height: 800 }) });
    const events = { ...NO_EVENTS, move: (move: { readonly id: string }) => void moves.push(move.id) };
    renderer.mount(undefined, events, undefined);
    renderer.draw(two());
    core?.getElementById('a').emit('grab');
    renderer.dispose();
    renderer.mount(undefined, events, undefined);
    renderer.draw(two());
    if (core !== undefined) emitAt(core.getElementById('a'), 'dragfree', { x: 500, y: 400 });
    expect(moves).toEqual([]);
    core?.getElementById('a').emit('grab');
    core?.getElementById('a').position({ x: 5, y: 6 });
    if (core !== undefined) emitAt(core.getElementById('a'), 'dragfree', { x: 500, y: 400 });
    expect(moves).toEqual(['a']);
  });

  it('keeps a drag that cancelled for a change of mode cancelled when the mode changes back, until the release', () => {
    const { renderer, grab, dragTo, entity, release, moves } = rig();
    renderer.draw(two());
    grab('a');
    dragTo('a', 90, 90);
    renderer.draw(withTool(two(), 'box'));
    renderer.draw(withTool(two(), 'select'));
    dragTo('a', 200, 200);
    release('a');
    expect(moves).toEqual([]);
    expect(entity('a').position()).toEqual({ x: 0, y: 0 });
  });

  it('reports no click for a drag, and leaves the view where it was', () => {
    const clicks: Click[] = [];
    let core: Core | undefined;
    const renderer = createCytoscapeRenderer({ nextFrame: (callback) => callback(), onCore: (made) => void (core = made), canvasSize: () => ({ width: 1000, height: 800 }) });
    renderer.mount(undefined, { ...NO_EVENTS, click: (click) => void clicks.push(click) }, undefined);
    renderer.draw(two());
    const before = renderer.inspect().viewport;
    const node = core?.getElementById('a');
    node?.emit('grab');
    node?.position({ x: 40, y: 40 });
    if (node !== undefined) emitAt(node, 'dragfree', { x: 500, y: 400 });
    expect(clicks).toEqual([]);
    expect(renderer.inspect().viewport).toEqual(before);
  });
});

describe('the captions the Cytoscape renderer paints in later frames', () => {
  const many = (count: number): Scene => ({ entities: Array.from({ length: count }, (_unused, index) => ({ id: `e${index}`, position: { x: index * 200, y: 0 }, look: { iconKey: 'generic' as const, line1: `ID-${index}`, line2: 'Type' } })), relationships: [], profile: undefined, omitted: 0, selection: new Set<string>(), pinned: new Set<string>(), tool: 'select' as const, source: null, view: 'fit' as const });

  it('report a failure of the painter after draw has returned, once, keep what is drawn, and paint no more', () => {
    const waiting: Array<() => void> = [];
    let failures = 0;
    let painted = 0;
    const renderer = createCytoscapeRenderer({
      nextFrame: (callback) => void waiting.push(callback),
      paintCaption: (line1) => {
        painted += 1;
        if (line1 === 'ID-1') throw new Error('cannot paint');
        return 'data:image/png;base64,AAAA';
      },
    });
    renderer.mount(undefined, { ...NO_EVENTS, failed: () => void (failures += 1) }, undefined);
    renderer.draw(many(4));
    expect(() => waiting.splice(0).forEach((callback) => callback())).not.toThrow();
    expect(failures).toBe(1);
    expect(waiting).toEqual([]);
    expect(painted).toBe(2);
    expect(renderer.describe().entities).toBe(4);
  });

  it('report nothing when the renderer was disposed before the failure', () => {
    const waiting: Array<() => void> = [];
    let failures = 0;
    const renderer = createCytoscapeRenderer({ nextFrame: (callback) => void waiting.push(callback), paintCaption: () => { throw new Error('cannot paint'); } });
    renderer.mount(undefined, { ...NO_EVENTS, failed: () => void (failures += 1) }, undefined);
    renderer.draw(many(2));
    renderer.dispose();
    waiting.splice(0).forEach((callback) => callback());
    expect(failures).toBe(0);
  });
});

describe('the endpoints of a relationship the Cytoscape renderer draws again', () => {
  it('follow the scene: a relationship with the same ID that now joins other entities is moved', () => {
    const renderer = mounted();
    const entities: Array<readonly [string, { x: number; y: number }]> = [['a', { x: 0, y: 0 }], ['b', { x: 50, y: 0 }], ['c', { x: 0, y: 50 }]];
    renderer.draw(scene(entities, [['r', 'a', 'b']]));
    renderer.draw(scene(entities, [['r', 'a', 'c']]));
    const [edge] = renderer.inspect().edges;
    expect(edge?.id).toBe('r');
    expect(renderer.inspect().edges.map((candidate) => [candidate.source, candidate.target])).toEqual([['a', 'c']]);
  });
});

describe('the initial view of the Cytoscape renderer', () => {
  const view = (entities: ReturnType<typeof scene>['entities'], mode: 'fit' | 'as-drawn'): Scene => ({ entities, relationships: [], profile: undefined, omitted: 0, selection: new Set<string>(), pinned: new Set<string>(), tool: 'select' as const, source: null, view: mode });
  const placed = (ids: readonly string[], offset = 0) => ids.map((id, index) => ({ id, position: { x: offset + index * 100, y: 0 }, look: { iconKey: 'generic' as const, line1: id, line2: 'T' } }));

  it('fits once when it first draws a graph whose entities are all positioned, and not again on a redraw', () => {
    const renderer = mounted();
    renderer.draw(view(placed(['a', 'b']), 'fit'));
    renderer.draw(view(placed(['a', 'b']), 'fit'));
    expect(renderer.inspect().fits).toBe(1);
  });

  it('fits again when the graph is replaced as a whole (a new source), and not when one entity is added', () => {
    const renderer = mounted();
    renderer.draw(view(placed(['a', 'b']), 'fit'));
    renderer.draw(view([...placed(['a', 'b']), ...placed(['c'], 300)], 'fit'));
    expect(renderer.inspect().fits).toBe(1);
    renderer.draw(view(placed(['x', 'y']), 'fit'));
    expect(renderer.inspect().fits).toBe(2);
  });

  it('fits again when the graph is replaced by one whose entities are all positioned', () => {
    const renderer = mounted();
    renderer.draw(view(placed(['a', 'b']), 'fit'));
    renderer.draw(view(placed(['x', 'y']), 'fit'));
    expect(renderer.inspect().fits).toBe(2);
    renderer.draw(view(placed(['x', 'y', 'z']), 'fit'));
    expect(renderer.inspect().fits).toBe(2);
  });

  it('leaves the viewport as the positions give it when the scene says as-drawn, and when nothing is drawn', () => {
    const renderer = mounted();
    renderer.draw(view(placed(['a']), 'as-drawn'));
    renderer.draw(view([], 'fit'));
    expect(renderer.inspect().fits).toBe(0);
  });
});

describe('the viewport the Cytoscape renderer reports', () => {
  it('is reported with finite numbers after the view changes, and once per animation frame however often it changes', () => {
    const frames: Array<() => void> = [];
    const reports: Viewport[] = [];
    const renderer = createCytoscapeRenderer({ nextFrame: (callback) => void frames.push(callback), canvasSize: () => ({ width: 800, height: 600 }) });
    renderer.mount(undefined, { viewport: (viewport) => void reports.push(viewport), click: () => undefined, box: () => undefined, contextMenu: () => undefined, move: () => undefined, failed: () => undefined }, undefined);
    renderer.draw(scene([['a', { x: 0, y: 0 }], ['b', { x: 100, y: 50 }]]));
    renderer.draw(scene([['a', { x: 0, y: 0 }], ['b', { x: 100, y: 50 }], ['c', { x: 5, y: 5 }]]));
    expect(reports).toHaveLength(0);
    expect(frames).toHaveLength(1);
    frames.splice(0).forEach((frame) => frame());
    expect(reports).toHaveLength(1);
    expect([reports[0]?.zoom, reports[0]?.x, reports[0]?.y].every(Number.isFinite)).toBe(true);
  });

  it('flushes the latest view once when the renderer is disposed with a report waiting, and reports nothing after that', () => {
    const frames: Array<() => void> = [];
    const reports: Viewport[] = [];
    const renderer = createCytoscapeRenderer({ nextFrame: (callback) => void frames.push(callback), canvasSize: () => ({ width: 800, height: 600 }) });
    renderer.mount(undefined, { viewport: (viewport) => void reports.push(viewport), click: () => undefined, box: () => undefined, contextMenu: () => undefined, move: () => undefined, failed: () => undefined }, undefined);
    renderer.draw(scene([['a', { x: 0, y: 0 }], ['b', { x: 100, y: 0 }]]));
    expect(reports).toHaveLength(0);
    renderer.dispose();
    expect(reports).toHaveLength(1);
    frames.splice(0).forEach((frame) => frame());
    expect(reports).toHaveLength(1);
  });

  it('reports nothing for a view change from before another source was drawn, but reports the fit of the new source that follows', () => {
    const frames: Array<() => void> = [];
    const reports: Viewport[] = [];
    const renderer = createCytoscapeRenderer({ nextFrame: (callback) => void frames.push(callback), canvasSize: () => ({ width: 800, height: 600 }) });
    renderer.mount(undefined, { viewport: (viewport) => void reports.push(viewport), click: () => undefined, box: () => undefined, contextMenu: () => undefined, move: () => undefined, failed: () => undefined }, undefined);
    const of = (source: string, ids: readonly string[]): Scene => ({ ...scene(ids.map((id, index) => [id, { x: index * 400, y: 0 }] as const)), source });
    renderer.draw(of('one', ['a', 'b']));
    renderer.draw(of('two', []));
    renderer.draw(of('two', ['x', 'y']));
    frames.splice(0).forEach((frame) => frame());
    expect(reports).toHaveLength(1);
    expect(reports[0]).toEqual({ zoom: renderer.inspect().viewport.zoom, x: renderer.inspect().viewport.x, y: renderer.inspect().viewport.y });
  });

  it('does not flush the view of a source that was left when the renderer is disposed', () => {
    const frames: Array<() => void> = [];
    const reports: Viewport[] = [];
    const renderer = createCytoscapeRenderer({ nextFrame: (callback) => void frames.push(callback), canvasSize: () => ({ width: 800, height: 600 }) });
    renderer.mount(undefined, { viewport: (viewport) => void reports.push(viewport), click: () => undefined, box: () => undefined, contextMenu: () => undefined, move: () => undefined, failed: () => undefined }, undefined);
    renderer.draw({ ...scene([['a', { x: 0, y: 0 }], ['b', { x: 400, y: 0 }]]), source: 'one' });
    renderer.draw({ ...scene([]), source: 'two' });
    renderer.dispose();
    frames.splice(0).forEach((frame) => frame());
    expect(reports).toHaveLength(0);
  });
});

describe('zoom and fit in the Cytoscape renderer', () => {
  const SIZE = { width: 800, height: 600 };
  const sized = () => {
    const renderer = createCytoscapeRenderer({ nextFrame: (callback) => callback(), canvasSize: () => SIZE });
    renderer.mount(undefined, NO_EVENTS, undefined);
    return renderer;
  };
  const spread = (width: number): ReturnType<typeof scene> => scene([['a', { x: 0, y: 0 }], ['b', { x: width, y: 0 }], ['c', { x: 0, y: width / 2 }]]);

  it('does nothing when it is asked to centre on a key that is not drawn, and does not throw', () => {
    const renderer = sized();
    renderer.draw(spread(400));
    const before = renderer.inspect().viewport;
    expect(() => renderer.centerOn('nothing')).not.toThrow();
    expect(renderer.inspect().viewport).toEqual(before);
  });

  it('pans so an entity is at the centre of the canvas, with the zoom and every position as they were', () => {
    let core: Core | undefined;
    const renderer = createCytoscapeRenderer({ nextFrame: (callback) => callback(), canvasSize: () => SIZE, onCore: (made) => void (core = made) });
    renderer.mount(undefined, NO_EVENTS, undefined);
    renderer.draw(spread(400));
    renderer.zoomBy(ZOOM_STEP);
    const before = renderer.inspect().viewport;
    const positions = new Map(renderer.positions());
    renderer.centerOn('b');
    const after = renderer.inspect().viewport;
    expect(after.zoom).toBe(before.zoom);
    expect(after.x !== before.x || after.y !== before.y).toBe(true);
    expect(renderer.positions()).toEqual(positions);
    const shown = core?.getElementById('b').renderedPosition();
    expect(shown?.x).toBeCloseTo((core?.width() ?? 0) / 2, 3);
    expect(shown?.y).toBeCloseTo((core?.height() ?? 0) / 2, 3);
  });

  it('pans so the middle of a relationship is at the centre of the canvas, with the zoom and every position as they were', () => {
    let core: Core | undefined;
    const renderer = createCytoscapeRenderer({ nextFrame: (callback) => callback(), canvasSize: () => SIZE, onCore: (made) => void (core = made) });
    renderer.mount(undefined, NO_EVENTS, undefined);
    renderer.draw({ ...spread(400), relationships: [{ id: 'ab', from: 'a', to: 'b', look: { aggregate: false, origin: 'stored' as const, label: undefined } }] });
    renderer.zoomBy(ZOOM_STEP);
    const zoom = renderer.inspect().viewport.zoom;
    const positions = new Map(renderer.positions());
    renderer.centerOn('ab');
    const { zoom: after, x, y } = renderer.inspect().viewport;
    expect(after).toBe(zoom);
    expect(renderer.positions()).toEqual(positions);
    const box = core?.getElementById('ab').boundingBox();
    expect(box).toBeDefined();
    expect(((box?.x1 ?? 0) + (box?.x2 ?? 0)) / 2 * after + x).toBeCloseTo((core?.width() ?? 0) / 2, 3);
    expect(((box?.y1 ?? 0) + (box?.y2 ?? 0)) / 2 * after + y).toBeCloseTo((core?.height() ?? 0) / 2, 3);
  });

  it('does nothing when it is asked to fit with nothing drawn', () => {
    const renderer = sized();
    const before = renderer.inspect().viewport;
    expect(() => renderer.fit()).not.toThrow();
    expect(renderer.inspect().viewport).toEqual(before);
  });

  it('keeps the zoom between the limits however many steps are taken in either direction', () => {
    const renderer = sized();
    renderer.draw(scene([['a', { x: 0, y: 0 }], ['b', { x: 100, y: 0 }]]));
    for (let step = 0; step < 100; step += 1) renderer.zoomBy(ZOOM_STEP);
    expect(renderer.inspect().viewport.zoom).toBe(ZOOM_MAX);
    for (let step = 0; step < 200; step += 1) renderer.zoomBy(1 / ZOOM_STEP);
    expect(renderer.inspect().viewport.zoom).toBeCloseTo(ZOOM_MIN, 10);
  });

  it('centres every entity in the canvas with the margin, and never fits a single entity beyond 100%', () => {
    const renderer = sized();
    renderer.draw(spread(1000));
    const box = renderer.inspect().boundingBox;
    expect(box).toBeDefined();
    if (box === undefined) return;
    expect((box.x1 + box.x2) / 2).toBeCloseTo(SIZE.width / 2, 3);
    expect((box.y1 + box.y2) / 2).toBeCloseTo(SIZE.height / 2, 3);
    expect(box.x1).toBeGreaterThanOrEqual(FIT_PADDING - 0.001);
    expect(box.y1).toBeGreaterThanOrEqual(FIT_PADDING - 0.001);
    expect(box.x2).toBeLessThanOrEqual(SIZE.width - FIT_PADDING + 0.001);
    expect(box.y2).toBeLessThanOrEqual(SIZE.height - FIT_PADDING + 0.001);
    const single = sized();
    single.draw(scene([['a', { x: 0, y: 0 }]]));
    expect(single.inspect().viewport.zoom).toBe(FIT_ZOOM_MAX);
    const lone = single.inspect().boundingBox;
    expect(((lone?.x1 ?? 0) + (lone?.x2 ?? 0)) / 2).toBeCloseTo(SIZE.width / 2, 3);
  });

  it('closes in on the entities when asked to fit them alone, leaving the aggregate nodes out, and never beyond 100% for one', () => {
    const renderer = sized();
    const base = scene([['a', { x: 0, y: 0 }], ['r', { x: 0, y: 6000 }]]);
    renderer.draw({ ...base, entities: base.entities.map((entity) => (entity.id === 'r' ? { ...entity, remainder: true } : entity)) });
    renderer.fit();
    const all = renderer.inspect().viewport.zoom;
    renderer.fit(true);
    const only = renderer.inspect().viewport.zoom;
    expect(all).toBeLessThan(FIT_ZOOM_MAX);
    expect(only).toBe(FIT_ZOOM_MAX);
    const spreadOut = sized();
    const two = scene([['a', { x: 0, y: 0 }], ['b', { x: 3000, y: 0 }], ['r', { x: 0, y: 9000 }]]);
    spreadOut.draw({ ...two, entities: two.entities.map((entity) => (entity.id === 'r' ? { ...entity, remainder: true } : entity)) });
    spreadOut.fit(true);
    const zoom = spreadOut.inspect().viewport.zoom;
    spreadOut.fit();
    expect(zoom).toBeGreaterThan(spreadOut.inspect().viewport.zoom);
  });

  it('fits a lone entity at 100%, lets the hand zoom go on to the maximum, and brings the view back to 100% on the fit command', () => {
    const renderer = sized();
    renderer.draw(scene([['a', { x: 0, y: 0 }]]));
    expect(renderer.inspect().viewport.zoom).toBe(FIT_ZOOM_MAX);
    for (let step = 0; step < 100; step += 1) renderer.zoomBy(ZOOM_STEP);
    expect(renderer.inspect().viewport.zoom).toBe(ZOOM_MAX);
    renderer.fit();
    expect(renderer.inspect().viewport.zoom).toBe(FIT_ZOOM_MAX);
  });

  it('fits a very spread drawing below the minimum zoom, then does not zoom out further and zooms in by the step up to the range', () => {
    const renderer = sized();
    renderer.draw(spread(30000));
    const fitted = renderer.inspect().viewport.zoom;
    expect(fitted).toBeLessThan(ZOOM_MIN);
    expect(renderer.inspect().zoomLimits.min).toBeCloseTo(fitted, 10);
    renderer.zoomBy(1 / ZOOM_STEP);
    expect(renderer.inspect().viewport.zoom).toBeCloseTo(fitted, 10);
    renderer.zoomBy(ZOOM_STEP);
    expect(renderer.inspect().viewport.zoom).toBeCloseTo(fitted * ZOOM_STEP, 10);
    for (let step = 0; step < 100; step += 1) renderer.zoomBy(ZOOM_STEP);
    expect(renderer.inspect().viewport.zoom).toBe(ZOOM_MAX);
    expect(renderer.inspect().zoomLimits.min).toBe(ZOOM_MIN);
  });

  it('runs the fit command again on request, from wherever the view is', () => {
    const renderer = sized();
    renderer.draw(spread(1000));
    const fitted = renderer.inspect().viewport;
    renderer.zoomBy(2);
    renderer.fit();
    expect(renderer.inspect().viewport.zoom).toBeCloseTo(fitted.zoom, 10);
  });
});

describe('the viewport the Cytoscape renderer is given when it is mounted', () => {
  const SIZE = { width: 800, height: 600 };
  const sizedWith = (viewport: Viewport | undefined) => {
    const renderer = createCytoscapeRenderer({ nextFrame: (callback) => callback(), canvasSize: () => SIZE });
    renderer.mount(undefined, NO_EVENTS, viewport);
    return renderer;
  };
  const entities = (ids: readonly string[], mode: 'fit' | 'as-drawn' = 'fit'): Scene => ({ ...scene(ids.map((id, index) => [id, { x: index * 300, y: 0 }] as const)), view: mode });

  it('shows a given viewport, including the identity one, and does not fit on the first drawing', () => {
    for (const given of [{ zoom: 2, x: 30, y: -10 }, { zoom: 1, x: 0, y: 0 }]) {
      const renderer = sizedWith(given);
      renderer.draw(entities(['a', 'b']));
      expect(renderer.inspect().viewport).toEqual(given);
      expect(renderer.inspect().fits).toBe(0);
    }
  });

  it('fits the first drawing that has entities when no viewport is given, and an empty drawing before it does not count', () => {
    const renderer = sizedWith(undefined);
    renderer.draw(entities([]));
    expect(renderer.inspect().fits).toBe(0);
    renderer.draw(entities(['a', 'b']));
    expect(renderer.inspect().fits).toBe(1);
  });

  it('keeps a given viewport when the graph goes from empty to loaded', () => {
    const given = { zoom: 0.5, x: 12, y: 7 };
    const renderer = sizedWith(given);
    renderer.draw(entities([]));
    renderer.draw(entities(['a', 'b']));
    expect(renderer.inspect().viewport).toEqual(given);
    expect(renderer.inspect().fits).toBe(0);
  });

  it('leaves the viewport alone when entities are added or move', () => {
    const renderer = sizedWith(undefined);
    renderer.draw(entities(['a', 'b']));
    const fitted = renderer.inspect().viewport;
    renderer.draw(entities(['a', 'b', 'c']));
    renderer.draw(scene([['a', { x: 5, y: 5 }], ['b', { x: 400, y: 9 }], ['c', { x: 1, y: 1 }]]));
    expect(renderer.inspect().viewport).toEqual(fitted);
    expect(renderer.inspect().fits).toBe(1);
  });

  it('fits again when the whole graph is replaced even with a viewport given at the start, but not on the first drawing', () => {
    const renderer = sizedWith({ zoom: 2, x: 0, y: 0 });
    renderer.draw(entities(['a', 'b']));
    expect(renderer.inspect().fits).toBe(0);
    renderer.draw(entities(['x', 'y']));
    expect(renderer.inspect().fits).toBe(1);
  });

  it('does not fit a drawing that is to be shown as positioned, and still applies a given viewport', () => {
    const given = { zoom: 1.5, x: 4, y: 4 };
    const renderer = sizedWith(given);
    renderer.draw(entities(['a', 'b'], 'as-drawn'));
    expect(renderer.inspect().viewport).toEqual(given);
    const bare = sizedWith(undefined);
    bare.draw(entities(['a', 'b'], 'as-drawn'));
    expect(bare.inspect().fits).toBe(0);
  });

  it('lets the minimum zoom follow a given viewport that is below it', () => {
    const renderer = sizedWith({ zoom: 0.02, x: 0, y: 0 });
    expect(renderer.inspect().zoomLimits.min).toBeCloseTo(0.02, 10);
  });

  it('fits a drawing of another source even when an empty drawing came between, and keeps the view when the same source goes from empty to loaded', () => {
    const renderer = sizedWith(undefined);
    const of = (source: string, ids: readonly string[]): Scene => ({ ...entities(ids), source });
    renderer.draw(of('one', ['a', 'b']));
    renderer.draw(of('one', []));
    renderer.draw(of('two', ['x', 'y']));
    expect(renderer.inspect().fits).toBe(2);
    const sameSource = sizedWith(undefined);
    sameSource.draw(of('one', ['a', 'b']));
    sameSource.draw(of('one', []));
    sameSource.draw(of('one', ['a', 'b']));
    expect(sameSource.inspect().fits).toBe(1);
  });
});

describe('the clicks and the selected look of the Cytoscape renderer', () => {
  const rendererWithCore = () => {
    const clicks: Click[] = [];
    let core: Core | undefined;
    const renderer = createCytoscapeRenderer({ nextFrame: (callback) => callback(), onCore: (made) => void (core = made) });
    renderer.mount(undefined, { viewport: () => undefined, click: (click) => void clicks.push(click), box: () => undefined, contextMenu: () => undefined, move: () => undefined, failed: () => undefined }, undefined);
    return {
      renderer,
      clicks,
      core: (): Core => {
        if (core === undefined) throw new Error('no core');
        return core;
      },
    };
  };
  const withSelection = (base: Scene, selected: readonly string[]): Scene => ({ ...base, selection: new Set(selected) });
  const ACCENT = 'rgb(82,100,167)';

  // The library's typings take only an event name; the library itself takes an event object that carries the original browser event.
  const shiftTap = (target: Core | ReturnType<Core['getElementById']>): void => {
    // @ts-expect-error the typings of `emit` do not allow an event object
    target.emit({ type: 'tap', originalEvent: new MouseEvent('click', { shiftKey: true }) });
  };

  it('reports a tap on an entity, on a relationship and on empty canvas, with Shift when it was held', () => {
    const { renderer, clicks, core } = rendererWithCore();
    renderer.draw(scene([['a', { x: 0, y: 0 }], ['b', { x: 100, y: 0 }]], [['ab', 'a', 'b']]));
    core().getElementById('a').emit('tap');
    core().getElementById('ab').emit('tap');
    core().emit('tap');
    shiftTap(core().getElementById('b'));
    shiftTap(core());
    expect(clicks).toEqual([
      { target: 'a', shift: false },
      { target: 'ab', shift: false },
      { target: undefined, shift: false },
      { target: 'b', shift: true },
      { target: undefined, shift: true },
    ]);
  });

  it('draws a selected entity with a heavier accent outline and a halo, and takes them away again when it is not selected', () => {
    const { renderer } = rendererWithCore();
    const base = scene([['a', { x: 0, y: 0 }], ['b', { x: 100, y: 0 }]]);
    renderer.draw(withSelection(base, ['a']));
    const nodes = new Map(renderer.inspect().nodes.map((node) => [node.id, node]));
    expect(nodes.get('a')).toMatchObject({ outline: ACCENT, outlineWidth: 1.8, diameter: 34.2, halo: true });
    expect(nodes.get('b')).toMatchObject({ outlineWidth: 1, diameter: 35, halo: false });
    renderer.draw(base);
    expect(renderer.inspect().nodes.every((node) => node.outlineWidth === 1 && !node.halo)).toBe(true);
  });

  it('draws a selected relationship in the accent colour one pixel wider, keeping its line style and its pill', () => {
    const { renderer } = rendererWithCore();
    const base = {
      ...scene([['a', { x: 0, y: 0 }], ['b', { x: 100, y: 0 }]]),
      relationships: [
        { id: 's', from: 'a', to: 'b', look: { aggregate: false, origin: 'stored' as const, label: undefined } },
        { id: 'g', from: 'a', to: 'b', look: { aggregate: true, origin: 'stored' as const, label: 'T · 42' } },
        { id: 'd', from: 'a', to: 'b', look: { aggregate: false, origin: 'derived' as const, label: 'T · derived' } },
        { id: 'u', from: 'a', to: 'b', look: { aggregate: false, origin: 'unknown' as const, label: 'T · origin unknown' } },
      ],
    };
    renderer.draw(withSelection(base, ['s', 'g', 'd', 'u']));
    const edges = new Map(renderer.inspect().edges.map((edge) => [edge.id, edge]));
    expect(edges.get('s')).toMatchObject({ width: 2.4, color: ACCENT, lineStyle: 'solid' });
    expect(edges.get('g')).toMatchObject({ width: 4.5, color: ACCENT, lineStyle: 'solid', label: 'T · 42', labelOutline: 1.5 });
    expect(edges.get('d')).toMatchObject({ width: 2.4, color: ACCENT, lineStyle: 'dashed', arrow: 'none' });
    expect(edges.get('u')).toMatchObject({ width: 2.4, color: ACCENT, lineStyle: 'dotted' });
    renderer.draw(base);
    expect(renderer.inspect().edges.find((edge) => edge.id === 's')).toMatchObject({ width: 1.4, color: 'rgb(140,150,168)' });
    expect(renderer.inspect().edges.find((edge) => edge.id === 'g')?.width).toBe(3.5);
  });
});

describe('the box a drag draws in the Cytoscape renderer', () => {
  const boxesFor = () => {
    const boxes: BoxSelection[] = [];
    const clicks: Click[] = [];
    let core: Core | undefined;
    const renderer = createCytoscapeRenderer({ nextFrame: (callback) => callback(), onCore: (made) => void (core = made), canvasSize: () => ({ width: 1000, height: 800 }) });
    renderer.mount(undefined, { viewport: () => undefined, click: (click) => void clicks.push(click), box: (box) => void boxes.push(box), contextMenu: () => undefined, move: () => undefined, failed: () => undefined }, { zoom: 1, x: 0, y: 0 });
    const drawn = (tool: 'select' | 'pan' | 'box'): void => {
      renderer.draw({ ...scene([['a', { x: 0, y: 0 }], ['b', { x: 100, y: 0 }], ['c', { x: 300, y: 300 }]]), tool, view: 'as-drawn' });
    };
    const target = (): Core => {
      if (core === undefined) throw new Error('no core');
      return core;
    };
    // The library's typings take only an event name; the library itself takes an event object with the pointer's position.
    const emit = (type: string, at: { x: number; y: number }, shift = false): void => {
      // @ts-expect-error the typings of `emit` do not allow an event object
      target().emit({ type, renderedPosition: at, originalEvent: new MouseEvent('mousedown', { shiftKey: shift }) });
    };
    const drag = (from: { x: number; y: number }, to: { x: number; y: number }, shift = false): void => {
      emit('tapstart', from, shift);
      emit('tapdrag', to, shift);
      emit('tapend', to, shift);
    };
    const onEntity = (id: string, type: string, at: { x: number; y: number }): void => {
      // @ts-expect-error the typings of `emit` do not allow an event object
      target().getElementById(id).emit({ type, renderedPosition: at, originalEvent: new MouseEvent('mousedown') });
    };
    return { renderer, boxes, clicks, drawn, drag, emit, onEntity };
  };

  it('selects the entities whose centre it holds in the mode box, and stops the view from panning only while it is drawn', () => {
    const { renderer, boxes, drawn, emit } = boxesFor();
    drawn('box');
    emit('tapstart', { x: -10, y: -10 });
    expect(renderer.inspect().interaction.panning).toBe(false);
    emit('tapdrag', { x: 120, y: 40 });
    emit('tapend', { x: 120, y: 40 });
    expect(boxes).toEqual([{ ids: ['a', 'b'], shift: false }]);
    expect(renderer.inspect().interaction.panning).toBe(true);
  });

  it('reports an empty box when it holds no entity', () => {
    const { boxes, drawn, drag } = boxesFor();
    drawn('box');
    drag({ x: 500, y: 500 }, { x: 600, y: 600 });
    expect(boxes).toEqual([{ ids: [], shift: false }]);
  });

  it('draws a box with Shift in the mode select, and reports that Shift was held; without Shift a drag in select is a pan and no box', () => {
    const { renderer, boxes, drawn, drag } = boxesFor();
    drawn('select');
    drag({ x: -10, y: -10 }, { x: 50, y: 50 });
    expect(boxes).toEqual([]);
    expect(renderer.inspect().interaction.panning).toBe(true);
    drag({ x: -10, y: -10 }, { x: 50, y: 50 }, true);
    expect(boxes).toEqual([{ ids: ['a'], shift: true }]);
  });

  it('adds with Shift in the mode box too', () => {
    const { boxes, drawn, drag } = boxesFor();
    drawn('box');
    drag({ x: -10, y: -10 }, { x: 50, y: 50 }, true);
    expect(boxes).toEqual([{ ids: ['a'], shift: true }]);
  });

  it('draws no box in the mode pan, with or without Shift, and moves the view by hand for a Shift-drag', () => {
    const { renderer, boxes, drawn, drag } = boxesFor();
    drawn('pan');
    drag({ x: -10, y: -10 }, { x: 50, y: 50 });
    expect(renderer.inspect().viewport).toMatchObject({ x: 0, y: 0 });
    drag({ x: -10, y: -10 }, { x: 50, y: 70 }, true);
    expect(boxes).toEqual([]);
    expect(renderer.inspect().interaction.panning).toBe(true);
    expect(renderer.inspect().viewport).toMatchObject({ x: 60, y: 80 });
  });

  it('ignores a press that starts on an entity, and a press and release in one place', () => {
    const { renderer, boxes, drawn, emit, onEntity } = boxesFor();
    drawn('box');
    onEntity('a', 'tapstart', { x: 0, y: 0 });
    onEntity('a', 'tapdrag', { x: 90, y: 90 });
    onEntity('a', 'tapend', { x: 90, y: 90 });
    emit('tapstart', { x: 20, y: 20 });
    emit('tapend', { x: 20, y: 20 });
    expect(boxes).toEqual([]);
    expect(renderer.inspect().interaction.panning).toBe(true);
  });

  it('cancels a box released outside the canvas, leaves the selection alone, and lets the view pan again', () => {
    const { renderer, boxes, drawn, emit } = boxesFor();
    drawn('box');
    emit('tapstart', { x: -10, y: -10 });
    emit('tapdrag', { x: 120, y: 40 });
    expect(renderer.inspect().interaction.panning).toBe(false);
    emit('tapend', { x: 5000, y: 40 });
    expect(boxes).toEqual([]);
    expect(renderer.inspect().interaction.panning).toBe(true);
  });

  it('cancels a box when the window loses focus, and ignores the click that may follow', () => {
    const { renderer, boxes, clicks, drawn, emit } = boxesFor();
    drawn('box');
    emit('tapstart', { x: -10, y: -10 });
    emit('tapdrag', { x: 120, y: 40 });
    window.dispatchEvent(new Event('blur'));
    expect(renderer.inspect().interaction.panning).toBe(true);
    emit('tap', { x: 20, y: 20 });
    expect(clicks).toEqual([]);
    emit('tapend', { x: 120, y: 40 });
    expect(boxes).toEqual([]);
  });

  it('stops listening for the window to lose focus once it is disposed', () => {
    const { renderer, drawn, boxes } = boxesFor();
    drawn('box');
    renderer.dispose();
    expect(() => window.dispatchEvent(new Event('blur'))).not.toThrow();
    expect(boxes).toEqual([]);
  });
});

describe('the label of a stored relationship in the Cytoscape renderer', () => {
  it('appears on the line when the scene gives it one and is gone in the same redraw when the scene takes it away', () => {
    const renderer = createCytoscapeRenderer({ nextFrame: (callback) => callback() });
    renderer.mount(undefined, { viewport: () => undefined, click: () => undefined, box: () => undefined, contextMenu: () => undefined, move: () => undefined, failed: () => undefined }, undefined);
    const base: Scene = { ...scene([['a', { x: 0, y: 0 }], ['b', { x: 100, y: 0 }]], [['ab', 'a', 'b']]) };
    const labelled = { ...base, relationships: base.relationships.map((relationship) => ({ ...relationship, look: { ...relationship.look, label: 'USES' } })) };
    renderer.draw(labelled);
    expect(renderer.inspect().edges[0]?.label).toBe('USES');
    renderer.draw(base);
    expect(renderer.inspect().edges[0]?.label).toBe('');
  });
});

describe('the right-click of the Cytoscape renderer', () => {
  const withMenus = () => {
    const requests: RightClick[] = [];
    let core: Core | undefined;
    const renderer = createCytoscapeRenderer({ nextFrame: (callback) => callback(), onCore: (made) => void (core = made) });
    renderer.mount(undefined, { viewport: () => undefined, click: () => undefined, box: () => undefined, contextMenu: (request) => void requests.push(request), move: () => undefined, failed: () => undefined }, undefined);
    renderer.draw(scene([['a', { x: 0, y: 0 }], ['b', { x: 100, y: 0 }]], [['ab', 'a', 'b']]));
    return {
      renderer,
      requests,
      core: (): Core => {
        if (core === undefined) throw new Error('no core');
        return core;
      },
    };
  };

  // The library's typings take only an event name; the library itself takes an event object that carries the original browser event.
  const rightClick = (target: Core | ReturnType<Core['getElementById']>, at: { readonly x: number; readonly y: number }): void => {
    // @ts-expect-error the typings of `emit` do not allow an event object
    target.emit({ type: 'cxttap', originalEvent: new MouseEvent('contextmenu', { clientX: at.x, clientY: at.y }) });
  };

  it('reports a right-click on an entity, on a relationship and on empty canvas, with the pointer position in the window', () => {
    const { requests, core } = withMenus();
    rightClick(core().getElementById('a'), { x: 11, y: 12 });
    rightClick(core().getElementById('ab'), { x: 21, y: 22 });
    rightClick(core(), { x: 31, y: 32 });
    expect(requests).toEqual([
      { target: { kind: 'node', key: 'a' }, x: 11, y: 12 },
      { target: { kind: 'relationship', key: 'ab' }, x: 21, y: 22 },
      { target: undefined, x: 31, y: 32 },
    ]);
  });

  it('reports nothing while a box is being drawn, and reports again once it is finished', () => {
    const { renderer, requests, core } = withMenus();
    renderer.draw({ ...scene([['a', { x: 0, y: 0 }], ['b', { x: 100, y: 0 }]]), tool: 'box', view: 'as-drawn' });
    const press = (type: string, at: { x: number; y: number }): void => {
      // @ts-expect-error the typings of `emit` do not allow an event object
      core().emit({ type, renderedPosition: at, originalEvent: new MouseEvent('mousedown') });
    };
    press('tapstart', { x: -10, y: -10 });
    rightClick(core(), { x: 1, y: 2 });
    expect(requests).toEqual([]);
    press('tapend', { x: 120, y: 40 });
    rightClick(core(), { x: 3, y: 4 });
    expect(requests).toEqual([{ target: undefined, x: 3, y: 4 }]);
  });

  it('reports nothing for a right-click that carries no browser mouse event', () => {
    const { requests, core } = withMenus();
    core().emit('cxttap');
    expect(requests).toEqual([]);
  });
});

describe('the Cytoscape renderer in a container whose size changes', () => {
  let restoreCanvas: () => void;
  let sizes: ReturnType<typeof stubSizeObserver>;
  const made: Array<{ readonly dispose: () => void }> = [];

  beforeEach(() => {
    restoreCanvas = stubCanvasContext();
    sizes = stubSizeObserver();
  });

  afterEach(() => {
    for (const renderer of made.splice(0)) renderer.dispose();
    sizes.restore();
    restoreCanvas();
  });

  function inContainer(nextFrame: (callback: () => void) => void = () => undefined, canvasSize?: () => { width: number; height: number }) {
    let core: Core | undefined;
    const renderer = createCytoscapeRenderer({ nextFrame, onCore: (made) => void (core = made), ...(canvasSize === undefined ? {} : { canvasSize }) });
    const container = document.createElement('div');
    document.body.append(container);
    sizes.resize(container, 1000, 800);
    made.push(renderer);
    renderer.mount(container, NO_EVENTS, { zoom: 1.5, x: -20, y: 30 });
    if (core === undefined) throw new Error('the renderer made no core');
    return { renderer, container, core };
  }

  it('says where an entity, a relationship and the canvas are on the page, by the browser window, and nothing for an item that is not drawn', () => {
    const { renderer, container, core } = inContainer();
    container.getBoundingClientRect = () => new DOMRect(30, 40, 1000, 800);
    renderer.draw(scene([['a', { x: 0, y: 0 }], ['b', { x: 200, y: 100 }]], [['ab', 'a', 'b']]));
    const at = core.getElementById('a').renderedPosition();
    expect(renderer.anchorOf('a')).toEqual({ x: 30 + at.x, y: 40 + at.y });
    const middle = core.getElementById('ab').renderedMidpoint();
    expect(renderer.anchorOf('ab')).toEqual({ x: 30 + middle.x, y: 40 + middle.y });
    expect(renderer.anchorOf(undefined)).toEqual({ x: 530, y: 440 });
    expect(renderer.anchorOf('gone')).toBeUndefined();
  });

  it('shows a not-allowed cursor over a pinned entity while a drag would move others, and no cursor of its own anywhere else', () => {
    const { renderer, container, core } = inContainer();
    const pinned = new Set(['a']);
    renderer.draw({ ...scene([['a', { x: 0, y: 0 }], ['b', { x: 100, y: 0 }]]), pinned });
    core.getElementById('a').emit('mouseover');
    expect(container.style.cursor).toBe('not-allowed');
    core.getElementById('a').emit('mouseout');
    expect(container.style.cursor).toBe('');
    core.getElementById('b').emit('mouseover');
    expect(container.style.cursor).toBe('');
    renderer.draw({ ...scene([['a', { x: 0, y: 0 }], ['b', { x: 100, y: 0 }]]), pinned, tool: 'pan' });
    core.getElementById('a').emit('mouseover');
    expect(container.style.cursor).toBe('');
    renderer.draw({ ...scene([['a', { x: 0, y: 0 }], ['b', { x: 100, y: 0 }]]), pinned, tool: 'box' });
    core.getElementById('a').emit('mouseover');
    expect(container.style.cursor).toBe('not-allowed');
  });

  it('follows a change of tool, of pin or of drawing under a pointer that does not move, and forgets the entity that was hovered when it is removed', () => {
    const { renderer, container, core } = inContainer();
    const two = (extra: object): Scene => ({ ...scene([['a', { x: 0, y: 0 }], ['b', { x: 100, y: 0 }]]), ...extra });
    renderer.draw(two({ pinned: new Set(['a']) }));
    core.getElementById('a').emit('mouseover');
    expect(container.style.cursor).toBe('not-allowed');
    renderer.draw(two({ pinned: new Set(['a']), tool: 'pan' }));
    expect(container.style.cursor).toBe('');
    renderer.draw(two({ pinned: new Set(['a']), tool: 'select' }));
    expect(container.style.cursor).toBe('not-allowed');
    renderer.draw(two({ pinned: new Set<string>() }));
    expect(container.style.cursor).toBe('');
    renderer.draw(two({ pinned: new Set(['a']) }));
    expect(container.style.cursor).toBe('not-allowed');
    renderer.draw({ ...scene([['b', { x: 100, y: 0 }]]), pinned: new Set(['a']) });
    expect(container.style.cursor).toBe('');
    renderer.draw(two({ pinned: new Set(['a']) }));
    expect(container.style.cursor).toBe('');
  });

  it('leaves no cursor on the container when the renderer is disposed over a pinned entity', () => {
    const { renderer, container, core } = inContainer();
    renderer.draw({ ...scene([['a', { x: 0, y: 0 }]]), pinned: new Set(['a']) });
    core.getElementById('a').emit('mouseover');
    expect(container.style.cursor).toBe('not-allowed');
    renderer.dispose();
    expect(container.style.cursor).toBe('');
  });

  describe('zoomed out past where captions are read', () => {
    const two = (extra: object = {}): Scene => ({ ...scene([['a', { x: 0, y: 0 }], ['b', { x: 200, y: 0 }]], [['ab', 'a', 'b']]), ...extra });
    const shown = (renderer: ReturnType<typeof inContainer>['renderer']) => ({ captions: renderer.inspect().nodes.map((node) => node.captionShown), labels: renderer.inspect().edges.map((edge) => edge.labelShown) });
    const labelled = (extra: object = {}): Scene => {
      const base = two(extra);
      return { ...base, relationships: base.relationships.map((relationship) => ({ ...relationship, look: { ...relationship.look, label: 'USES' } })) };
    };

    it('draws no ring while the scene says a menu holds the focus, and rings the element again when the menu is gone', () => {
      const { renderer } = inContainer((callback) => callback());
      const ringed = () => ({ nodes: renderer.inspect().nodes.map((node) => node.focused), edges: renderer.inspect().edges.map((edge) => edge.focused) });
      renderer.draw(labelled({ focused: 'b' }));
      expect(ringed().nodes).toEqual([false, true]);
      renderer.draw(labelled({ focused: 'b', focusRing: false }));
      expect(ringed()).toEqual({ nodes: [false, false], edges: [false] });
      renderer.draw(labelled({ focused: 'ab', focusRing: false }));
      expect(ringed()).toEqual({ nodes: [false, false], edges: [false] });
      renderer.draw(labelled({ focused: 'b' }));
      expect(ringed().nodes).toEqual([false, true]);
    });

    it('keeps the caption and the label of the walk element below the limit while the ring is hidden for a menu', () => {
      const { renderer, core } = inContainer((callback) => callback());
      core.zoom(CAPTION_MIN_ZOOM * 0.5);
      renderer.draw(labelled({ focused: 'a', focusRing: false }));
      expect(shown(renderer)).toEqual({ captions: [true, false], labels: [false] });
      renderer.draw(labelled({ focused: 'ab', focusRing: false }));
      expect(shown(renderer)).toEqual({ captions: [false, false], labels: [true] });
    });

    it('rings a derived relationship with a gap, and keeps it dashed inside the ring', () => {
      const { renderer } = inContainer((callback) => callback());
      const base = two({ focused: 'ab' });
      renderer.draw({ ...base, relationships: base.relationships.map((relationship) => ({ ...relationship, look: { ...relationship.look, origin: 'derived' as const } })) });
      const [edge] = renderer.inspect().edges;
      expect(edge).toMatchObject({ focused: true, lineStyle: 'dashed' });
      expect(edge?.lineOutline).toBeGreaterThan(0);
      renderer.draw({ ...base, focusRing: false, relationships: base.relationships.map((relationship) => ({ ...relationship, look: { ...relationship.look, origin: 'derived' as const } })) });
      expect(renderer.inspect().edges[0]).toMatchObject({ focused: false, lineStyle: 'dashed' });
    });

    it('rings the entity or the relationship the scene says the walk is at, moves the ring, takes it away, and keeps the caption and label of the one it is at below the limit', () => {
      const { renderer, core } = inContainer((callback) => callback());
      const ringed = () => ({ nodes: renderer.inspect().nodes.map((node) => node.focused), edges: renderer.inspect().edges.map((edge) => edge.focused) });
      renderer.draw(labelled());
      expect(ringed()).toEqual({ nodes: [false, false], edges: [false] });
      renderer.draw(labelled({ focused: 'b' }));
      expect(ringed()).toEqual({ nodes: [false, true], edges: [false] });
      renderer.draw(labelled({ focused: 'ab' }));
      expect(ringed()).toEqual({ nodes: [false, false], edges: [true] });
      core.zoom(CAPTION_MIN_ZOOM * 0.5);
      expect(shown(renderer)).toEqual({ captions: [false, false], labels: [true] });
      renderer.draw(labelled({ focused: 'a' }));
      expect(shown(renderer)).toEqual({ captions: [true, false], labels: [false] });
      renderer.draw(labelled());
      expect(ringed()).toEqual({ nodes: [false, false], edges: [false] });
    });

    it('shows every caption and label at a zoom where they are read, and hides all of them below it, keeping the glyphs and the badges', () => {
      const { renderer, core } = inContainer((callback) => callback());
      renderer.draw(labelled({ pinned: new Set(['a']) }));
      core.zoom(CAPTION_MIN_ZOOM * 1.5);
      expect(shown(renderer)).toEqual({ captions: [true, true], labels: [true] });
      core.zoom(CAPTION_MIN_ZOOM * 0.5);
      expect(shown(renderer)).toEqual({ captions: [false, false], labels: [false] });
      expect(core.nodes().map((node) => String(node.style('background-image-opacity')))).toEqual(['1 0 1', '1 0 1']);
      expect(renderer.inspect().nodes.map((node) => [node.glyphShown, node.captionShown, node.badgeShown])).toEqual([[true, false, true], [true, false, false]]);
      expect(renderer.describe()).toEqual({ entities: 2, relationships: 1 });
      core.zoom(CAPTION_MIN_ZOOM * 1.5);
      expect(shown(renderer)).toEqual({ captions: [true, true], labels: [true] });
    });

    it('keeps the caption and label of a selected entity and a selected relationship, and not of the one under the pointer, which the tip tells', () => {
      const { renderer, core } = inContainer((callback) => callback());
      renderer.draw(labelled({ selection: new Set(['a', 'ab']) }));
      core.zoom(CAPTION_MIN_ZOOM * 0.5);
      expect(shown(renderer)).toEqual({ captions: [true, false], labels: [true] });
      renderer.draw(labelled());
      expect(shown(renderer)).toEqual({ captions: [false, false], labels: [false] });
      core.getElementById('b').emit('mouseover');
      expect(shown(renderer)).toEqual({ captions: [false, false], labels: [false] });
    });

    describe('the readable caption of the element under the pointer', () => {
      const tipOf = (container: HTMLElement): string[] | undefined => {
        const tip = container.querySelector('.canvas-tip');
        return tip === null ? undefined : [...tip.querySelectorAll('p')].map((line) => line.textContent ?? '');
      };

      it('shows an entity as its title and its type line, and a relationship as its label, below the limit, none for an entity at a zoom where captions are read, and none for a relationship without a label', () => {
        const { renderer, container, core } = inContainer((callback) => callback());
        renderer.draw(labelled());
        const [first] = renderer.inspect().nodes;
        core.zoom(CAPTION_MIN_ZOOM * 1.5);
        core.getElementById('a').emit('mouseover');
        expect(tipOf(container)).toBeUndefined();
        core.getElementById('a').emit('mouseout');
        core.zoom(CAPTION_MIN_ZOOM * 0.5);
        core.getElementById('a').emit('mouseover');
        expect(tipOf(container)).toEqual(first?.caption.split('\n'));
        core.getElementById('a').emit('mouseout');
        expect(tipOf(container)).toBeUndefined();
        core.getElementById('ab').emit('mouseover');
        expect(tipOf(container)).toEqual(['USES']);
        core.getElementById('ab').emit('mouseout');
        renderer.draw(two());
        core.getElementById('ab').emit('mouseover');
        expect(tipOf(container)).toBeUndefined();
      });

      it('keeps the title and the type line as they are, also when the title holds a line break, and hides when the canvas is resized', () => {
        const { renderer, container, core } = inContainer((callback) => callback());
        renderer.draw({ ...labelled(), entities: [{ id: 'a', position: { x: 0, y: 0 }, look: { iconKey: 'generic', line1: 'ACC\n1', line2: 'Alpha · Open' } }], relationships: [] });
        core.zoom(CAPTION_MIN_ZOOM * 0.5);
        core.getElementById('a').emit('mouseover');
        expect(tipOf(container)).toEqual(['ACC\n1', 'Alpha · Open']);
        sizes.resize(container, 500, 400);
        expect(tipOf(container)).toBeUndefined();
      });

      it('also tells the element the keyboard walk is at, and tells it again each time the walk moves, whatever the pointer does', () => {
        const { renderer, container, core } = inContainer((callback) => callback());
        renderer.draw(labelled());
        core.zoom(CAPTION_MIN_ZOOM * 1.5);
        renderer.draw(labelled({ focused: 'a' }));
        expect(tipOf(container)).toBeUndefined();
        core.zoom(CAPTION_MIN_ZOOM * 0.5);
        expect(tipOf(container)).toBeUndefined();
        renderer.draw(labelled());
        renderer.draw(labelled({ focused: 'a' }));
        expect(tipOf(container)).toEqual(renderer.inspect().nodes[0]?.caption.split('\n'));
        core.panBy({ x: 5, y: 5 });
        expect(tipOf(container)).toBeUndefined();
        renderer.draw(labelled({ focused: 'ab' }));
        expect(tipOf(container)).toEqual(['USES']);
        core.getElementById('b').emit('mouseover');
        expect(tipOf(container)?.[0]).toBe(renderer.inspect().nodes[1]?.caption.split('\n')[0]);
        core.getElementById('b').emit('mouseout');
        expect(tipOf(container)).toEqual(['USES']);
        renderer.draw(labelled());
        expect(tipOf(container)).toBeUndefined();
      });

      it('moves the view to the element the walk reaches when it is outside the canvas, and leaves the view alone when the element is inside or the walk stays where it is', () => {
        const { renderer, core } = inContainer((callback) => callback(), () => ({ width: 1000, height: 800 }));
        const spread = (extra: object = {}): Scene => ({ ...labelled(extra), view: 'as-drawn' as const, entities: [{ id: 'a', position: { x: 0, y: 0 }, look: { iconKey: 'generic', line1: 'a', line2: 'Type' } }, { id: 'b', position: { x: 5000, y: 3000 }, look: { iconKey: 'generic', line1: 'b', line2: 'Type' } }], relationships: [] });
        const inView = (id: string): boolean => {
          const at = core.getElementById(id).renderedPosition();
          return at.x >= 48 && at.x <= 1000 - 48 && at.y >= 48 && at.y <= 800 - 48;
        };
        renderer.draw(spread());
        expect(inView('b')).toBe(false);
        renderer.draw(spread({ focused: 'b' }));
        expect(inView('b')).toBe(true);
        const pan = { ...core.pan() };
        renderer.draw(spread({ focused: 'b', selection: new Set(['b']) }));
        expect(core.pan()).toEqual(pan);
        renderer.draw(spread({ focused: 'a' }));
        expect(inView('a')).toBe(true);
        const settled = { ...core.pan() };
        renderer.draw(spread({}));
        expect(core.pan()).toEqual(settled);
      });

      it('is one at a time, whatever is selected, and is the page\'s own text, not drawn by the library, and not announced', () => {
        const { renderer, container, core } = inContainer((callback) => callback());
        renderer.draw(labelled({ selection: new Set(['a', 'b', 'ab']) }));
        core.zoom(CAPTION_MIN_ZOOM * 0.5);
        expect(container.querySelectorAll('.canvas-tip')).toHaveLength(0);
        core.getElementById('a').emit('mouseover');
        core.getElementById('b').emit('mouseover');
        expect(container.querySelectorAll('.canvas-tip')).toHaveLength(1);
        expect(container.querySelector('.canvas-tip')?.getAttribute('aria-hidden')).toBe('true');
      });

      it('goes with a pan, a zoom, a grab, the pointer leaving the canvas, the element being removed and the renderer being disposed, and comes back with the next element the pointer enters', () => {
        const { renderer, container, core } = inContainer((callback) => callback());
        renderer.draw(labelled());
        core.zoom(CAPTION_MIN_ZOOM * 0.5);
        for (const away of [() => core.panBy({ x: 5, y: 5 }), () => core.zoom(CAPTION_MIN_ZOOM * 0.4), () => core.getElementById('a').emit('grab'), () => core.emit('mouseout')]) {
          core.getElementById('a').emit('mouseover');
          expect(tipOf(container)).toBeDefined();
          away();
          expect(tipOf(container)).toBeUndefined();
        }
        core.getElementById('b').emit('mouseover');
        expect(tipOf(container)).toBeDefined();
        renderer.draw({ ...labelled(), entities: labelled().entities.filter((entity) => entity.id !== 'b'), relationships: [] });
        expect(tipOf(container)).toBeUndefined();
        core.getElementById('a').emit('mouseover');
        expect(tipOf(container)).toBeDefined();
        renderer.dispose();
        expect(container.querySelector('.canvas-tip')).toBeNull();
      });

      it('is gone when the zoom comes back to where captions are read', () => {
        const { renderer, container, core } = inContainer((callback) => callback());
        renderer.draw(labelled());
        core.zoom(CAPTION_MIN_ZOOM * 0.5);
        core.getElementById('a').emit('mouseover');
        core.zoom(CAPTION_MIN_ZOOM * 1.5);
        expect(tipOf(container)).toBeUndefined();
      });
    });

    it('hides the caption of an entity drawn while zoomed out, and shows it again when the zoom comes back', () => {
      const { renderer, core } = inContainer((callback) => callback());
      renderer.draw(labelled());
      core.zoom(CAPTION_MIN_ZOOM * 0.5);
      renderer.draw({ ...labelled(), entities: [...labelled().entities, { id: 'c', position: { x: 400, y: 0 }, look: { iconKey: 'generic', line1: 'c', line2: 'Type' } }] });
      expect(shown(renderer).captions).toEqual([false, false, false]);
      core.zoom(1);
      expect(shown(renderer).captions).toEqual([true, true, true]);
    });

    it('forgets the element under the pointer when the pointer leaves the canvas from it, so its tip does not stay out of the canvas', () => {
      const { renderer, container, core } = inContainer((callback) => callback());
      renderer.draw(labelled({ pinned: new Set(['a']) }));
      core.zoom(CAPTION_MIN_ZOOM * 0.5);
      core.getElementById('a').emit('mouseover');
      expect(container.querySelector('.canvas-tip')).not.toBeNull();
      expect(container.style.cursor).toBe('not-allowed');
      core.emit('mouseout');
      expect(container.querySelector('.canvas-tip')).toBeNull();
      expect(container.style.cursor).toBe('');
    });

    it('takes the element under the pointer up again when the pointer comes back over it after leaving the canvas, which the library does not tell the element, and not when it comes back elsewhere', () => {
      const { renderer, container, core } = inContainer((callback) => callback());
      renderer.draw(labelled({ pinned: new Set(['a']) }));
      core.zoom(CAPTION_MIN_ZOOM * 0.5);
      const tips = () => container.querySelectorAll('.canvas-tip').length;
      core.getElementById('a').emit('mouseover');
      core.emit('mouseout');
      expect(tips()).toBe(0);
      core.emit('mouseover');
      expect(tips()).toBe(1);
      expect(container.style.cursor).toBe('not-allowed');
      core.getElementById('a').emit('mouseout');
      core.emit('mouseout');
      core.emit('mouseover');
      expect(tips()).toBe(0);
      core.getElementById('ab').emit('mouseover');
      core.emit('mouseout');
      core.emit('mouseover');
      expect(container.querySelector('.canvas-tip-title')?.textContent).toBe('USES');
    });

    it('forgets the element it would have taken up again when that element is removed or the renderer is disposed', () => {
      let latest: Core | undefined;
      const renderer = createCytoscapeRenderer({ nextFrame: (callback) => callback(), onCore: (made) => void (latest = made) });
      made.push(renderer);
      const first = document.createElement('div');
      document.body.append(first);
      sizes.resize(first, 1000, 800);
      renderer.mount(first, NO_EVENTS, { zoom: 1.5, x: -20, y: 30 });
      const current = (): Core => {
        if (latest === undefined) throw new Error('the renderer made no core');
        return latest;
      };
      const core = current();
      renderer.draw(labelled({ pinned: new Set(['a']) }));
      core.zoom(CAPTION_MIN_ZOOM * 0.5);
      core.getElementById('a').emit('mouseover');
      core.emit('mouseout');
      renderer.draw({ ...labelled(), entities: labelled().entities.filter((entity) => entity.id !== 'a'), relationships: [] });
      renderer.draw(labelled());
      core.emit('mouseover');
      expect(core.elements('.hovered').length).toBe(0);
      core.getElementById('a').emit('mouseover');
      core.emit('mouseout');
      renderer.dispose();
      const again = document.createElement('div');
      document.body.append(again);
      sizes.resize(again, 1000, 800);
      renderer.mount(again, NO_EVENTS, { zoom: 1.5, x: -20, y: 30 });
      renderer.draw(labelled());
      current().zoom(CAPTION_MIN_ZOOM * 0.5);
      current().emit('mouseover');
      expect(current().elements('.hovered').length).toBe(0);
    });

    it('draws a relationship whose label comes while zoomed out without it, and leaves one with no label alone', () => {
      const { renderer, core } = inContainer((callback) => callback());
      const plain = two();
      renderer.draw(plain);
      core.zoom(CAPTION_MIN_ZOOM * 0.5);
      expect(core.edges('.far').length).toBe(0);
      renderer.draw(labelled());
      expect(shown(renderer).labels).toEqual([false]);
      expect(core.edges('.far').length).toBe(1);
      core.zoom(1);
      expect(shown(renderer).labels).toEqual([true]);
    });

    it('hides the captions of many entities ten at a time over the next frames, not all in the frame of the zoom, and starts again from the other side when the zoom turns back', () => {
      const frames: Array<() => void> = [];
      let core: Core | undefined;
      const renderer = createCytoscapeRenderer({ nextFrame: (callback) => void frames.push(callback), onCore: (made) => void (core = made), canvasSize: () => ({ width: 1000, height: 800 }), paintCaption: () => 'data:image/png;base64,AAAA' });
      renderer.mount(undefined, NO_EVENTS, undefined);
      const ids = Array.from({ length: 25 }, (_unused, index) => `e${index}`);
      renderer.draw(scene(ids.map((id, index) => [id, { x: index * 10, y: 0 }] as const)));
      const cy = core;
      if (cy === undefined) throw new Error('no core');
      const hidden = (): number => cy.nodes('.far').length;
      frames.length = 0;
      cy.zoom(CAPTION_MIN_ZOOM * 0.5);
      expect(hidden()).toBe(0);
      expect(frames).toHaveLength(1);
      const counts: number[] = [];
      while (frames.length > 0) {
        frames.shift()?.();
        counts.push(hidden());
      }
      expect(counts).toEqual([10, 20, 25]);
      cy.zoom(CAPTION_MIN_ZOOM * 2);
      frames.shift()?.();
      expect(hidden()).toBe(15);
      cy.zoom(CAPTION_MIN_ZOOM * 0.5);
      while (frames.length > 0) frames.shift()?.();
      expect(hidden()).toBe(25);
    });

    it('gives an entity drawn while zoomed out the class from the start, and finishes the others at once when a draw follows a fit', () => {
      const frames: Array<() => void> = [];
      let core: Core | undefined;
      const renderer = createCytoscapeRenderer({ nextFrame: (callback) => void frames.push(callback), onCore: (made) => void (core = made), canvasSize: () => ({ width: 1000, height: 800 }), paintCaption: () => 'data:image/png;base64,AAAA' });
      renderer.mount(undefined, NO_EVENTS, undefined);
      const far = (count: number): Scene => scene(Array.from({ length: count }, (_unused, index) => [`e${index}`, { x: index * 5000, y: 0 }] as const));
      renderer.draw(far(3));
      const cy = core;
      if (cy === undefined) throw new Error('no core');
      expect(cy.zoom()).toBeLessThan(CAPTION_MIN_ZOOM);
      expect(cy.nodes('.far').length).toBe(3);
      renderer.draw(far(4));
      expect(cy.nodes('.far').length).toBe(4);
    });

    it('does the work once when the zoom crosses the limit, and none at each zoom step on either side, and encodes no caption again', () => {
      let paints = 0;
      let core: Core | undefined;
      const renderer = createCytoscapeRenderer({ nextFrame: (callback) => callback(), onCore: (made) => void (core = made), paintCaption: () => { paints += 1; return 'data:image/png;base64,AAAA'; }, canvasSize: () => ({ width: 1000, height: 800 }) });
      renderer.mount(undefined, NO_EVENTS, undefined);
      renderer.draw(labelled());
      const cy = core;
      if (cy === undefined) throw new Error('no core');
      const painted = paints;
      const batches: number[] = [];
      const original = cy.batch.bind(cy);
      cy.batch = (callback: () => void) => {
        batches.push(1);
        original(callback);
      };
      for (const level of [1, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7]) cy.zoom(level);
      expect(batches).toHaveLength(0);
      cy.zoom(0.5);
      expect(batches).toHaveLength(1);
      for (const level of [0.45, 0.4, 0.35, 0.3, 0.25]) cy.zoom(level);
      expect(batches).toHaveLength(1);
      cy.zoom(1);
      expect(batches).toHaveLength(2);
      expect(paints).toBe(painted);
    });
  });

  it('tells the library to measure again each time the container changes size, and not before', () => {
    const { container, core } = inContainer();
    const resized = vi.spyOn(core, 'resize');
    expect(resized).not.toHaveBeenCalled();
    sizes.resize(container, 700, 800);
    sizes.resize(container, 900, 800);
    expect(resized).toHaveBeenCalledTimes(2);
  });

  it('keeps the zoom and the pan and does not fit the graph again', () => {
    const { renderer, container, core } = inContainer();
    renderer.draw(scene([['a', { x: 0, y: 0 }], ['b', { x: 400, y: 300 }]]));
    const before = renderer.viewport();
    const set = vi.spyOn(core, 'viewport');
    sizes.resize(container, 600, 800);
    sizes.resize(container, 1100, 800);
    expect(renderer.viewport()).toEqual(before);
    expect(set).not.toHaveBeenCalled();
  });

  it('stops following the container when disposed, and a change after that reaches nothing', () => {
    const { renderer, container, core } = inContainer();
    const resized = vi.spyOn(core, 'resize');
    expect(sizes.observed()).toContain(container);
    renderer.dispose();
    expect(sizes.observed()).not.toContain(container);
    sizes.resize(container, 500, 800);
    expect(resized).not.toHaveBeenCalled();
  });

  it('watches nothing when mounted without a container', () => {
    const renderer = createCytoscapeRenderer({ nextFrame: () => undefined });
    renderer.mount(undefined, NO_EVENTS, undefined);
    expect(sizes.observed()).toEqual([]);
  });
});

describe('the aggregate nodes the Cytoscape renderer draws', () => {
  const withRemainder = (): Scene => {
    const base = scene([['a', { x: 0, y: 0 }], ['r', { x: 150, y: 0 }]], [['link', 'a', 'r']]);
    return { ...base, entities: base.entities.map((entity) => (entity.id === 'r' ? { ...entity, remainder: true } : entity)), relationships: base.relationships.map((relationship) => ({ ...relationship, remainder: true })) };
  };

  it('are drawn but not counted among the entities and relationships, nor listed among the drawn nodes and positions', () => {
    const renderer = mounted();
    renderer.draw(withRemainder());
    expect(renderer.describe()).toEqual({ entities: 1, relationships: 0 });
    expect([...renderer.positions().keys()]).toEqual(['a']);
    const drawn = renderer.inspect();
    expect(drawn.nodes.map((node) => node.id)).toEqual(['a']);
    expect(drawn.edges).toEqual([]);
    expect(drawn.remainders.map((node) => node.id)).toEqual(['r']);
  });

  it('cannot be grabbed, in any pointer tool', () => {
    const renderer = mounted();
    renderer.draw(withRemainder());
    expect(renderer.inspect().remainders).toEqual([{ id: 'r', caption: 'r\nType', grabbable: false }]);
  });

  it('are removed with their line when the scene no longer holds them', () => {
    const renderer = mounted();
    renderer.draw(withRemainder());
    renderer.draw(scene([['a', { x: 0, y: 0 }]]));
    expect(renderer.inspect().remainders).toEqual([]);
  });
});
