import { describe, expect, it } from 'vitest';
import { createCytoscapeRenderer, type RendererCore as Core } from './cytoscape-renderer.js';
import { glyphUri } from './glyphs.js';
import { FIT_PADDING, GLYPH_COLOR } from './look.js';
import { ZOOM_MAX, ZOOM_MIN, ZOOM_STEP } from './zoom.js';
import type { CanvasEvents, RightClick, Scene } from './scene.js';
import type { BoxSelection } from './box-selection.js';
import type { Click } from './selection-gestures.js';
import type { Viewport } from '../state/presentation-state.js';

function scene(entities: ReadonlyArray<readonly [string, { x: number; y: number } | undefined]>, relationships: ReadonlyArray<readonly [string, string, string]> = []): Scene {
  return {
    entities: entities.map(([id, position]) => ({ id, position, look: { iconKey: 'generic' as const, line1: id, line2: 'Type' } })),
    relationships: relationships.map(([id, from, to]) => ({ id, from, to, look: { aggregate: false, origin: 'stored' as const, label: undefined } })),
    profile: undefined,
    omitted: 0, selection: new Set<string>(), tool: 'select' as const, source: null,
    view: 'fit' as const,
  };
}

const NO_EVENTS: CanvasEvents = { viewport: () => undefined, click: () => undefined, box: () => undefined, contextMenu: () => undefined };

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

  it('places only the entities that have no position, and leaves the others where they were', () => {
    const renderer = mounted();
    const placed = renderer.draw(scene([['a', { x: 10, y: 20 }], ['b', undefined], ['c', undefined]], [['ab', 'a', 'b'], ['ac', 'a', 'c']]));
    expect([...placed.keys()].sort()).toEqual(['b', 'c']);
    expect(placed.get('b')).not.toEqual(placed.get('c'));
    const again = renderer.draw(scene([['a', { x: 10, y: 20 }], ['b', placed.get('b')], ['c', placed.get('c')]], [['ab', 'a', 'b'], ['ac', 'a', 'c']]));
    expect(again.size).toBe(0);
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
    const placed = renderer.draw(scene([['a', { x: 5, y: 6 }]]));
    expect(placed.size).toBe(0);
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

describe('the entities the Cytoscape renderer draws', () => {
  const look = (iconKey: 'generic' | 'money', line1: string, line2: string) => ({ iconKey, line1, line2 });
  const one = (position: { x: number; y: number } | undefined, entityLook = look('money', 'ACC-1', 'Alpha · Open')): Scene => ({ entities: [{ id: 'a', position, look: entityLook }], relationships: [], profile: undefined, omitted: 0, selection: new Set<string>(), tool: 'select' as const, source: null, view: 'fit' as const });

  it('draws a disc 36 px across its 1 px outline, the glyph of its icon key and the caption its look names', () => {
    const painted: string[] = [];
    const renderer = createCytoscapeRenderer({ paintCaption: (line1, line2) => { painted.push(`${line1}|${line2}`); return 'data:image/png;base64,AAAA'; } });
    renderer.mount(undefined, NO_EVENTS, undefined);
    renderer.draw(one({ x: 0, y: 0 }));
    const [node] = renderer.inspect().nodes;
    expect(node?.diameter).toBe(35);
    expect((node?.diameter ?? 0) + 1).toBe(36);
    expect(node?.images).toEqual([glyphUri('money', GLYPH_COLOR), 'data:image/png;base64,AAAA']);
    expect(node?.caption).toBe('ACC-1\nAlpha · Open');
    expect(painted).toEqual(['ACC-1|Alpha · Open']);
  });

  it('paints a caption once however often it is drawn, and again only for another text', () => {
    let paints = 0;
    const renderer = createCytoscapeRenderer({ paintCaption: () => { paints += 1; return 'data:image/png;base64,AAAA'; } });
    renderer.mount(undefined, NO_EVENTS, undefined);
    renderer.draw(one({ x: 0, y: 0 }));
    renderer.draw(one({ x: 0, y: 0 }));
    renderer.draw({ entities: [{ id: 'a', position: { x: 0, y: 0 }, look: look('money', 'ACC-1', 'Alpha · Open') }, { id: 'b', position: { x: 90, y: 0 }, look: look('money', 'ACC-1', 'Alpha · Open') }], relationships: [], profile: undefined, omitted: 0, selection: new Set<string>(), tool: 'select' as const, source: null, view: 'fit' as const });
    expect(paints).toBe(1);
    renderer.draw(one({ x: 0, y: 0 }, look('generic', 'ACC-1', 'Alpha · Closed')));
    expect(paints).toBe(2);
  });

  it('changes the glyph and the caption when the look changes, without moving the entity', () => {
    const renderer = createCytoscapeRenderer({ paintCaption: (line1) => `data:image/png;base64,${btoa(line1)}` });
    renderer.mount(undefined, NO_EVENTS, undefined);
    renderer.draw(one({ x: 11, y: 22 }, look('generic', 'ACC-1', 'type-a')));
    const first = renderer.inspect().nodes[0];
    renderer.draw(one({ x: 11, y: 22 }, look('money', 'ACC-1', 'Alpha')));
    const second = renderer.inspect().nodes[0];
    expect(first?.images[0]).toBe(glyphUri('generic', GLYPH_COLOR));
    expect(second?.images[0]).toBe(glyphUri('money', GLYPH_COLOR));
    expect(second?.caption).toBe('ACC-1\nAlpha');
    expect(renderer.draw(one({ x: 11, y: 22 }, look('money', 'ACC-1', 'Alpha'))).size).toBe(0);
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
    omitted: 0, selection: new Set<string>(), tool: 'select' as const, source: null,
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
  it('lets it pan and zoom and nothing else (not box-select, select or move) until the features that own those are built', () => {
    const renderer = mounted();
    renderer.draw(scene([['a', { x: 0, y: 0 }]]));
    expect(renderer.inspect().interaction).toEqual({ panning: true, zooming: true, boxSelecting: false, nodesGrabbable: false, nodesSelectable: false });
  });
});

describe('the endpoints of a relationship the Cytoscape renderer draws again', () => {
  it('follow the scene: a relationship with the same ID that now joins other entities is moved', () => {
    const renderer = mounted();
    const entities: Array<readonly [string, { x: number; y: number } | undefined]> = [['a', { x: 0, y: 0 }], ['b', { x: 50, y: 0 }], ['c', { x: 0, y: 50 }]];
    renderer.draw(scene(entities, [['r', 'a', 'b']]));
    renderer.draw(scene(entities, [['r', 'a', 'c']]));
    const [edge] = renderer.inspect().edges;
    expect(edge?.id).toBe('r');
    expect(renderer.inspect().edges.map((candidate) => [candidate.source, candidate.target])).toEqual([['a', 'c']]);
  });
});

describe('the initial view of the Cytoscape renderer', () => {
  const view = (entities: ReturnType<typeof scene>['entities'], mode: 'fit' | 'as-drawn'): Scene => ({ entities, relationships: [], profile: undefined, omitted: 0, selection: new Set<string>(), tool: 'select' as const, source: null, view: mode });
  const placed = (ids: readonly string[], at: boolean) => ids.map((id, index) => ({ id, position: at ? { x: index * 100, y: 0 } : undefined, look: { iconKey: 'generic' as const, line1: id, line2: 'T' } }));

  it('fits once when it first draws a graph whose entities are all positioned, and not again on a redraw', () => {
    const renderer = mounted();
    renderer.draw(view(placed(['a', 'b'], true), 'fit'));
    renderer.draw(view(placed(['a', 'b'], true), 'fit'));
    expect(renderer.inspect().fits).toBe(1);
  });

  it('fits again when the graph is replaced as a whole (a new source), and not when one entity is added', () => {
    const renderer = mounted();
    renderer.draw(view(placed(['a', 'b'], true), 'fit'));
    renderer.draw(view([...placed(['a', 'b'], true), ...placed(['c'], false)], 'fit'));
    expect(renderer.inspect().fits).toBe(1);
    renderer.draw(view(placed(['x', 'y'], false), 'fit'));
    expect(renderer.inspect().fits).toBe(2);
  });

  it('fits again when the graph is replaced by one whose entities are all positioned', () => {
    const renderer = mounted();
    renderer.draw(view(placed(['a', 'b'], true), 'fit'));
    renderer.draw(view(placed(['x', 'y'], true), 'fit'));
    expect(renderer.inspect().fits).toBe(2);
    renderer.draw(view(placed(['x', 'y', 'z'], true), 'fit'));
    expect(renderer.inspect().fits).toBe(2);
  });

  it('leaves the viewport as the positions give it when the scene says as-drawn, and when nothing is drawn', () => {
    const renderer = mounted();
    renderer.draw(view(placed(['a'], true), 'as-drawn'));
    renderer.draw(view([], 'fit'));
    expect(renderer.inspect().fits).toBe(0);
  });
});

describe('the viewport the Cytoscape renderer reports', () => {
  it('is reported with finite numbers after the view changes, and once per animation frame however often it changes', () => {
    const frames: Array<() => void> = [];
    const reports: Viewport[] = [];
    const renderer = createCytoscapeRenderer({ nextFrame: (callback) => void frames.push(callback), canvasSize: () => ({ width: 800, height: 600 }) });
    renderer.mount(undefined, { viewport: (viewport) => void reports.push(viewport), click: () => undefined, box: () => undefined, contextMenu: () => undefined }, undefined);
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
    renderer.mount(undefined, { viewport: (viewport) => void reports.push(viewport), click: () => undefined, box: () => undefined, contextMenu: () => undefined }, undefined);
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
    renderer.mount(undefined, { viewport: (viewport) => void reports.push(viewport), click: () => undefined, box: () => undefined, contextMenu: () => undefined }, undefined);
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
    renderer.mount(undefined, { viewport: (viewport) => void reports.push(viewport), click: () => undefined, box: () => undefined, contextMenu: () => undefined }, undefined);
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

  it('centres every entity in the canvas with the margin, and never zooms a single entity beyond the maximum', () => {
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
    expect(single.inspect().viewport.zoom).toBeLessThanOrEqual(ZOOM_MAX);
    const lone = single.inspect().boundingBox;
    expect(((lone?.x1 ?? 0) + (lone?.x2 ?? 0)) / 2).toBeCloseTo(SIZE.width / 2, 3);
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
    renderer.mount(undefined, { viewport: () => undefined, click: (click) => void clicks.push(click), box: () => undefined, contextMenu: () => undefined }, undefined);
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
    renderer.mount(undefined, { viewport: () => undefined, click: (click) => void clicks.push(click), box: (box) => void boxes.push(box), contextMenu: () => undefined }, { zoom: 1, x: 0, y: 0 });
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
    renderer.mount(undefined, { viewport: () => undefined, click: () => undefined, box: () => undefined, contextMenu: () => undefined }, undefined);
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
    renderer.mount(undefined, { viewport: () => undefined, click: () => undefined, box: () => undefined, contextMenu: (request) => void requests.push(request) }, undefined);
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
