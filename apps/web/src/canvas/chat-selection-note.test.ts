import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCytoscapeRenderer, type RendererCore as Core } from './cytoscape-renderer.js';
import { buildScene } from './build-scene.js';
import { CAPTION_COLOR } from './look.js';
import type { CanvasEvents, Scene, SceneEntity } from './scene.js';

beforeEach(() => void vi.spyOn(performance, 'now').mockReturnValue(0));
afterEach(() => vi.restoreAllMocks());

const NO_EVENTS: CanvasEvents = { viewport: () => undefined, click: () => undefined, box: () => undefined, contextMenu: () => undefined, move: () => undefined, failed: () => undefined };
const CAPTION = 'data:image/png;base64,Q0FQVElPTg==';
const entityOf = (id: string): SceneEntity => ({ id, position: { x: id === 'b' ? 200 : 0, y: 0 }, look: { iconKey: 'generic', line1: id, line2: 'Type' } });
const sceneOf = (noted?: Scene['noted']): Scene => ({ entities: [entityOf('a'), entityOf('b')], relationships: [], profile: undefined, omitted: 0, selection: new Set(), pinned: new Set(), tool: 'select', source: 's', view: 'fit', ...(noted === undefined ? {} : { noted }) });

function mounted() {
  let core: Core | undefined;
  const renderer = createCytoscapeRenderer({ nextFrame: (callback) => callback(), onCore: (made) => void (core = made), paintCaption: () => CAPTION });
  renderer.mount(undefined, NO_EVENTS, undefined);
  return { renderer, node: (id: string) => core?.getElementById(id) };
}

describe('the note under the element another window selected', () => {
  it('draws no note on any node of a scene that holds none', () => {
    const { renderer, node } = mounted();
    renderer.draw(sceneOf());
    expect(node('a')?.data('note')).toBe('');
    expect(node('a')?.style('label')).toBe('');
  });

  it('draws the text as a label of that node only, in the accent colour, below its caption', () => {
    const { renderer, node } = mounted();
    renderer.draw(sceneOf({ key: 'a', text: 'Selected from the chat window' }));
    expect(node('a')?.data('note')).toBe('Selected from the chat window');
    expect(node('a')?.style('label')).toBe('Selected from the chat window');
    expect(node('a')?.style('color')).not.toBe(CAPTION_COLOR);
    expect(node('b')?.style('label')).toBe('');
    expect(node('a')?.numericStyle('text-margin-y')).toBeGreaterThan(0);
  });

  it('takes the note off when the scene no longer holds it, and moves it to another node', () => {
    const { renderer, node } = mounted();
    renderer.draw(sceneOf({ key: 'a', text: 'Selected from the chat window' }));
    renderer.draw(sceneOf({ key: 'b', text: 'Selected from the chat window' }));
    expect(node('a')?.style('label')).toBe('');
    expect(node('b')?.style('label')).toBe('Selected from the chat window');
    renderer.draw(sceneOf());
    expect(node('b')?.style('label')).toBe('');
  });
});

describe('where the note is drawn', () => {
  it('is hidden with the captions when the canvas is zoomed out, and shown while the element is selected', () => {
    const { renderer, node } = mounted();
    renderer.draw({ ...sceneOf({ key: 'a', text: 'Selected from the chat window' }), selection: new Set(['a']) });
    const element = node('a');
    element?.addClass('far');
    expect(element?.numericStyle('text-opacity')).toBe(1);
    renderer.draw({ ...sceneOf({ key: 'a', text: 'Selected from the chat window' }), selection: new Set() });
    node('a')?.addClass('far');
    expect(node('a')?.numericStyle('text-opacity')).toBe(0);
  });

  it('is put in the scene for an entity it draws only: a key that is no entity of the graph, such as a relationship, gets none', () => {
    const graph = { sourceId: 's', nodes: [], edges: [] } as unknown as Parameters<typeof buildScene>[0];
    const scene = buildScene(graph, new Map(), undefined, new Set(), 'select', 's', 'fit', new Set(), undefined, true, [], { key: '["edge","s","stored","T","a","b","e1"]', text: 'Selected from the chat window' });
    expect(scene.noted).toBeUndefined();
  });
});
