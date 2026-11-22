import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCytoscapeRenderer, type RendererCore as Core } from './cytoscape-renderer.js';
import type { CanvasEvents, Scene } from './scene.js';

beforeEach(() => void vi.spyOn(performance, 'now').mockReturnValue(0));
afterEach(() => vi.restoreAllMocks());

const NO_EVENTS: CanvasEvents = { viewport: () => undefined, click: () => undefined, box: () => undefined, contextMenu: () => undefined, move: () => undefined, failed: () => undefined };

function groupedScene(): Scene {
  return {
    entities: [
      { id: 'a', position: { x: 0, y: 0 }, look: { iconKey: 'generic' as const, line1: 'a', line2: 'Type' } },
      { id: 'b', position: { x: 200, y: 0 }, look: { iconKey: 'generic' as const, line1: 'b', line2: 'Type' } },
      { id: 'group:g1', position: { x: 100, y: 200 }, group: { id: 'g1', count: 3 }, look: { iconKey: 'generic' as const, line1: 'Kind D', line2: '3 loaded' } },
    ],
    relationships: [{ id: 'ab', from: 'a', to: 'group:g1', look: { aggregate: true, origin: 'stored' as const, label: '×2', badge: '×2' } }],
    containers: [{ id: 'container:g2', label: 'Kind A · 2 loaded', members: ['a', 'b'] }],
    profile: undefined,
    omitted: 0,
    selection: new Set<string>(),
    pinned: new Set<string>(),
    tool: 'select' as const,
    source: null,
    view: 'fit' as const,
  };
}

function mounted() {
  let core: Core | undefined;
  const renderer = createCytoscapeRenderer({ nextFrame: (callback) => callback(), onCore: (made) => void (core = made) });
  renderer.mount(undefined, NO_EVENTS, undefined);
  return { renderer, core: () => core };
}

describe('the Cytoscape renderer with groups', () => {
  it('draws the card as a node that can be dragged and is not an entity of the view: not counted, not in the positions, not among the aggregate nodes', () => {
    const { renderer, core } = mounted();
    renderer.draw(groupedScene());
    const card = core()?.getElementById('group:g1');
    expect(card?.data('group')).toBe(true);
    expect(card?.grabbable()).toBe(true);
    expect(card?.data('caption')).toBe('Kind D\n3 loaded');
    expect(renderer.describe()).toEqual({ entities: 2, relationships: 1 });
    expect([...renderer.positions().keys()].sort()).toEqual(['a', 'b']);
    expect(renderer.inspect().remainders).toEqual([]);
  });

  it('draws the container behind the members as a node that cannot be touched, sized to the members with the room for their captions, and draws it again when they move', () => {
    const { renderer, core } = mounted();
    renderer.draw(groupedScene());
    const container = core()?.getElementById('container:g2');
    expect(container?.data('container')).toBe(true);
    expect(container?.grabbable()).toBe(false);
    expect(container?.data('w')).toBeGreaterThan(200);
    expect(container?.data('caption')).toBe('Kind A · 2 loaded');
    const wide = container?.data('w');
    const moved = groupedScene();
    renderer.draw({ ...moved, entities: moved.entities.map((entity) => (entity.id === 'b' ? { ...entity, position: { x: 600, y: 0 } } : entity)) });
    expect(core()?.getElementById('container:g2').data('w')).toBeGreaterThan(wide);
  });

  it('removes the card and the container when the scene no longer holds them', () => {
    const { renderer, core } = mounted();
    renderer.draw(groupedScene());
    renderer.draw({ ...groupedScene(), entities: groupedScene().entities.filter((entity) => entity.group === undefined), relationships: [], containers: [] });
    expect(core()?.getElementById('group:g1').empty()).toBe(true);
    expect(core()?.getElementById('container:g2').empty()).toBe(true);
  });

  it('gives the card the badge of its count as an image and a second outline behind it in the style', () => {
    const { renderer, core } = mounted();
    renderer.draw(groupedScene());
    const images = core()?.getElementById('group:g1').style('background-image') ?? '';
    expect(decodeURIComponent(String(images))).toContain('>3</text>');
  });
});
