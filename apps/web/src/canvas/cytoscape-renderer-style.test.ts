import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCytoscapeRenderer, type RendererCore as Core } from './cytoscape-renderer.js';
import { NODE_DIAMETER, NODE_OUTER_DIAMETER, NODE_OUTLINE_WIDTH, SELECTED_OUTLINE_WIDTH, STYLE_COLOR_OUTLINE_WIDTH, STYLE_LARGER_FACTOR, STYLE_TONE_COLORS } from './look.js';
import type { CanvasEvents, Scene, SceneEntity } from './scene.js';
import type { StyleLook } from './style-look.js';

beforeEach(() => void vi.spyOn(performance, 'now').mockReturnValue(0));
afterEach(() => vi.restoreAllMocks());

const NO_EVENTS: CanvasEvents = { viewport: () => undefined, click: () => undefined, box: () => undefined, contextMenu: () => undefined, move: () => undefined, failed: () => undefined };
const CAPTION = 'data:image/png;base64,Q0FQVElPTg==';

const entityOf = (id: string, style?: StyleLook): SceneEntity => ({ id, position: { x: id === 'b' ? 200 : 0, y: 0 }, look: { iconKey: 'generic', line1: id, line2: 'Type', ...(style === undefined ? {} : { style }) } });

const sceneOf = (entities: SceneEntity[], pinned: string[] = [], selected: string[] = []): Scene => ({ entities, relationships: [], profile: undefined, omitted: 0, selection: new Set(selected), pinned: new Set(pinned), tool: 'select', source: null, view: 'fit' });

function mounted() {
  let core: Core | undefined;
  const renderer = createCytoscapeRenderer({ nextFrame: (callback) => callback(), onCore: (made) => void (core = made), paintCaption: () => CAPTION });
  renderer.mount(undefined, NO_EVENTS, undefined);
  return { renderer, node: (id: string) => core?.getElementById(id) };
}

describe('the Cytoscape renderer with style rules', () => {
  it('draws a node no rule gives a look exactly as before: no style data, the usual size and outline', () => {
    const { renderer, node } = mounted();
    renderer.draw(sceneOf([entityOf('a')]));
    const plain = node('a');
    expect(plain?.data('styleColor')).toBe('');
    expect(plain?.data('larger')).toBe(false);
    expect(plain?.data('lowerPin')).toBe(false);
    expect(plain?.numericStyle('width')).toBe(NODE_DIAMETER);
    expect(plain?.numericStyle('border-width')).toBe(NODE_OUTLINE_WIDTH);
  });

  it('puts the badge of a rule in its own slot, over a clear pixel where the caption or the pin is not yet drawn', () => {
    const { renderer, node } = mounted();
    renderer.draw(sceneOf([entityOf('a', { badge: 'amber', labels: ['Review'] })]));
    const decoded = decodeURIComponent(String(node('a')?.style('background-image')));
    expect(decoded).toContain(STYLE_TONE_COLORS.amber);
    expect((decoded.match(/data:image/g) ?? []).length).toBe(4);
  });

  it('moves the pin badge to the lower right when the node has a style badge, and keeps it at the upper right otherwise', () => {
    const { renderer, node } = mounted();
    renderer.draw(sceneOf([entityOf('a', { badge: 'red', labels: ['x'] }), entityOf('b')], ['a', 'b']));
    expect(node('a')?.data('lowerPin')).toBe(true);
    expect(node('b')?.data('lowerPin')).toBe(false);
    const lower = node('a')?.style('background-position-y');
    const upper = node('b')?.style('background-position-y');
    const pinOf = (value: unknown): number => parseFloat(String(value).split(' ')[2] ?? '0');
    expect(pinOf(lower)).toBeGreaterThan(NODE_DIAMETER / 2);
    expect(pinOf(upper)).toBeLessThan(NODE_DIAMETER / 2);
  });

  it('draws the colour of a rule on the outline and the glyph, wider than the plain outline', () => {
    const { renderer, node } = mounted();
    renderer.draw(sceneOf([entityOf('a', { color: 'green', labels: ['x'] })]));
    expect(node('a')?.data('styleColor')).toBe('green');
    expect(node('a')?.style('border-color')).toBe('rgb(46,139,87)');
    expect(node('a')?.numericStyle('border-width')).toBe(STYLE_COLOR_OUTLINE_WIDTH);
    expect(decodeURIComponent(String(node('a')?.style('background-image')))).toContain(STYLE_TONE_COLORS.green);
  });

  it('draws a node a rule enlarges at the factor of its diameter, with its caption as far lower as it grows, and back to the usual size when the rule goes', () => {
    const { renderer, node } = mounted();
    renderer.draw(sceneOf([entityOf('a', { larger: true, labels: ['x'] })]));
    expect(node('a')?.numericStyle('width')).toBeCloseTo(NODE_DIAMETER * STYLE_LARGER_FACTOR);
    const captionTop = (value: unknown): number => parseFloat(String(value).split(' ')[1] ?? '0');
    const grown = captionTop(node('a')?.style('background-position-y'));
    renderer.draw(sceneOf([entityOf('a')]));
    expect(node('a')?.numericStyle('width')).toBe(NODE_DIAMETER);
    expect(grown - captionTop(node('a')?.style('background-position-y'))).toBeCloseTo(NODE_DIAMETER * (STYLE_LARGER_FACTOR - 1));
  });

  it('keeps a selected node that a rule enlarges at the enlarged size, with and without a badge, and draws the usual selected size for another', () => {
    const { renderer, node } = mounted();
    renderer.draw(sceneOf([entityOf('a', { larger: true, labels: ['x'] }), entityOf('b', { larger: true, badge: 'amber', labels: ['y'] })], [], ['a', 'b']));
    const usual = NODE_OUTER_DIAMETER - SELECTED_OUTLINE_WIDTH;
    expect(node('a')?.numericStyle('width')).toBeCloseTo(usual * STYLE_LARGER_FACTOR);
    expect(node('b')?.numericStyle('width')).toBeCloseTo(usual * STYLE_LARGER_FACTOR);
    renderer.draw(sceneOf([entityOf('a'), entityOf('b')], [], ['a', 'b']));
    expect(node('a')?.numericStyle('width')).toBeCloseTo(usual);
  });

  it('puts the names of the rules in the hover tip data of the node', () => {
    const { renderer, node } = mounted();
    const entity = entityOf('a', { badge: 'amber', labels: ['Review'] });
    renderer.draw(sceneOf([{ ...entity, look: { ...entity.look, tip: { title: 'a', detail: 'Type\nStyle: Review' } } }]));
    expect(node('a')?.data('detail')).toBe('Type\nStyle: Review');
  });
});

describe('what the images of a node say of its look', () => {
  it('lists the glyph, then the caption, then the pin slot, then the badge of a rule', () => {
    const { renderer, node } = mounted();
    renderer.draw(sceneOf([entityOf('a', { badge: 'amber', labels: ['x'] })]));
    const decoded = decodeURIComponent(String(node('a')?.style('background-image')));
    expect(decoded.indexOf(CAPTION)).toBeGreaterThan(-1);
    expect(decoded.indexOf(CAPTION)).toBeLessThan(decoded.indexOf(STYLE_TONE_COLORS.amber));
  });
});
