import { describe, expect, it } from 'vitest';
import { createCytoscapeRenderer } from './cytoscape-renderer.js';
import { glyphUri } from './glyphs.js';
import { GLYPH_COLOR } from './look.js';
import type { Scene } from './scene.js';

function scene(entities: ReadonlyArray<readonly [string, { x: number; y: number } | undefined]>, relationships: ReadonlyArray<readonly [string, string, string]> = []): Scene {
  return {
    entities: entities.map(([id, position]) => ({ id, position, look: { iconKey: 'generic' as const, line1: id, line2: 'Type' } })),
    relationships: relationships.map(([id, from, to]) => ({ id, from, to, look: { aggregate: false, origin: 'stored' as const, label: undefined } })),
    profile: undefined,
    omitted: 0,
    view: 'fit' as const,
  };
}

function mounted() {
  const renderer = createCytoscapeRenderer();
  renderer.mount(undefined);
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
    renderer.mount(undefined);
    expect(() => renderer.mount(undefined)).toThrow('already mounted');
    renderer.dispose();
    expect(() => renderer.describe()).toThrow('not mounted');
    renderer.mount(undefined);
    expect(renderer.describe()).toEqual({ entities: 0, relationships: 0 });
  });
});

describe('the entities the Cytoscape renderer draws', () => {
  const look = (iconKey: 'generic' | 'money', line1: string, line2: string) => ({ iconKey, line1, line2 });
  const one = (position: { x: number; y: number } | undefined, entityLook = look('money', 'ACC-1', 'Alpha · Open')): Scene => ({ entities: [{ id: 'a', position, look: entityLook }], relationships: [], profile: undefined, omitted: 0, view: 'fit' as const });

  it('draws a disc 36 px across its 1 px outline, the glyph of its icon key and the caption its look names', () => {
    const painted: string[] = [];
    const renderer = createCytoscapeRenderer({ paintCaption: (line1, line2) => { painted.push(`${line1}|${line2}`); return 'data:image/png;base64,AAAA'; } });
    renderer.mount(undefined);
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
    renderer.mount(undefined);
    renderer.draw(one({ x: 0, y: 0 }));
    renderer.draw(one({ x: 0, y: 0 }));
    renderer.draw({ entities: [{ id: 'a', position: { x: 0, y: 0 }, look: look('money', 'ACC-1', 'Alpha · Open') }, { id: 'b', position: { x: 90, y: 0 }, look: look('money', 'ACC-1', 'Alpha · Open') }], relationships: [], profile: undefined, omitted: 0, view: 'fit' as const });
    expect(paints).toBe(1);
    renderer.draw(one({ x: 0, y: 0 }, look('generic', 'ACC-1', 'Alpha · Closed')));
    expect(paints).toBe(2);
  });

  it('changes the glyph and the caption when the look changes, without moving the entity', () => {
    const renderer = createCytoscapeRenderer({ paintCaption: (line1) => `data:image/png;base64,${btoa(line1)}` });
    renderer.mount(undefined);
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
    renderer.mount(undefined);
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
    omitted: 0,
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
  it('lets it pan, zoom, box-select, select or move nothing, until the features that own those are built', () => {
    const renderer = mounted();
    renderer.draw(scene([['a', { x: 0, y: 0 }]]));
    expect(renderer.inspect().interaction).toEqual({ panning: false, zooming: false, boxSelecting: false, nodesGrabbable: false, nodesSelectable: false });
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
  const view = (entities: ReturnType<typeof scene>['entities'], mode: 'fit' | 'as-drawn'): Scene => ({ entities, relationships: [], profile: undefined, omitted: 0, view: mode });
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
