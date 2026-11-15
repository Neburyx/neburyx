import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCytoscapeRenderer, type RendererCore as Core } from './cytoscape-renderer.js';
import { CAPTION_MIN_ZOOM } from './look.js';
import type { CanvasEvents, Scene } from './scene.js';
import { SnapshotUnavailable, snapshotScale } from './snapshot.js';

const NO_EVENTS: CanvasEvents = { viewport: () => undefined, click: () => undefined, box: () => undefined, contextMenu: () => undefined, move: () => undefined, failed: () => undefined };
const BOUNDS = { maxWidth: 8000, maxHeight: 6000, maxArea: 16_000_000 };
const PICTURE = new Blob(['png'], { type: 'image/png' });

function scene(entities: ReadonlyArray<readonly [string, { x: number; y: number }]>, selection: readonly string[] = []): Scene {
  return {
    entities: entities.map(([id, position]) => ({ id, position, look: { iconKey: 'generic' as const, line1: id, line2: 'Type' } })),
    relationships: entities.length > 1 ? [{ id: 'ab', from: 'a', to: 'b', look: { aggregate: false, origin: 'stored' as const, label: 'LINK' } }] : [],
    profile: undefined,
    omitted: 0, selection: new Set<string>(selection), pinned: new Set<string>(), tool: 'select' as const, source: null,
    view: 'fit' as const,
  };
}

beforeEach(() => void vi.spyOn(performance, 'now').mockReturnValue(0));
afterEach(() => vi.restoreAllMocks());

function mounted(paintCaption = vi.fn(() => 'data:image/png;base64,AAAA')) {
  let core: Core | undefined;
  const renderer = createCytoscapeRenderer({ nextFrame: (callback) => void setTimeout(callback, 0), paintCaption, onCore: (made) => void (core = made) });
  renderer.mount(undefined, NO_EVENTS, undefined);
  const png = vi.fn((_options: unknown) => Promise.resolve(PICTURE));
  if (core === undefined) throw new Error('no core');
  Object.assign(core, { png });
  return { renderer, core, png, paintCaption };
}

const TWO = [['a', { x: 0, y: 0 }], ['b', { x: 300, y: 100 }]] as const;

describe('snapshotScale', () => {
  it('keeps the preferred scale for a small drawing', () => {
    expect(snapshotScale({ width: 400, height: 300 }, BOUNDS)).toBe(2);
  });

  it('goes down until the longer side is within its bound', () => {
    expect(snapshotScale({ width: 16_000, height: 100 }, BOUNDS)).toBe(0.5);
  });

  it('goes down until the area is within its bound, even when both sides are', () => {
    const scale = snapshotScale({ width: 6000, height: 5000 }, BOUNDS);
    expect(6000 * scale * 5000 * scale).toBeLessThanOrEqual(BOUNDS.maxArea + 1);
    expect(6000 * scale).toBeLessThanOrEqual(BOUNDS.maxWidth);
  });
});

describe('the picture of the drawn view', () => {
  it('fails with a named reason when nothing is mounted', async () => {
    const renderer = createCytoscapeRenderer({ nextFrame: (callback) => callback() });
    await expect(renderer.snapshot(BOUNDS)).rejects.toEqual(expect.objectContaining({ reason: 'not-mounted' }));
    await expect(renderer.snapshot(BOUNDS)).rejects.toBeInstanceOf(SnapshotUnavailable);
  });

  it('fails with a named reason when nothing is drawn, and takes no picture', async () => {
    const { renderer, png } = mounted();
    await expect(renderer.snapshot(BOUNDS)).rejects.toEqual(expect.objectContaining({ reason: 'empty' }));
    expect(png).not.toHaveBeenCalled();
  });

  it('takes the whole drawing on the canvas colour, with the largest size it may have, and no scale of its own', async () => {
    const { renderer, png, core } = mounted();
    renderer.draw(scene(TWO));
    await expect(renderer.snapshot(BOUNDS)).resolves.toBe(PICTURE);
    const options = png.mock.calls[0]?.[0] as { readonly [key: string]: unknown };
    expect(options).toMatchObject({ output: 'blob-promise', full: true, bg: '#fafbfc', maxWidth: expect.any(Number), maxHeight: expect.any(Number) });
    expect(options).not.toHaveProperty('scale');
    const box = core.elements().boundingBox();
    expect(options['maxWidth']).toBeLessThanOrEqual(Math.ceil(box.w) * 2);
    expect(options['maxHeight']).toBeLessThanOrEqual(Math.ceil(box.h) * 2);
  });

  it('gives sizes within the bounds for a very wide drawing, so the library\'s own pixel ratio cannot take it over', async () => {
    const { renderer, png } = mounted();
    renderer.draw(scene([['a', { x: 0, y: 0 }], ['b', { x: 40_000, y: 0 }]]));
    await renderer.snapshot(BOUNDS);
    const [{ maxWidth, maxHeight }] = png.mock.calls[0] as [{ maxWidth: number; maxHeight: number }];
    expect(maxWidth).toBeLessThanOrEqual(BOUNDS.maxWidth);
    expect(maxHeight).toBeLessThanOrEqual(BOUNDS.maxHeight);
    expect(maxWidth * maxHeight).toBeLessThanOrEqual(BOUNDS.maxArea);
  });

  it('draws every caption and label whatever the zoom, and puts the zoomed-out look back after', async () => {
    const { renderer, core, png } = mounted();
    renderer.draw(scene(TWO));
    core.zoom(CAPTION_MIN_ZOOM / 2);
    renderer.show({ zoom: CAPTION_MIN_ZOOM / 2, x: 0, y: 0 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(core.elements('.far').length).toBeGreaterThan(0);
    const far = core.elements('.far').length;
    let during = -1;
    png.mockImplementation(() => {
      during = core.elements('.far').length;
      return Promise.resolve(PICTURE);
    });
    await renderer.snapshot(BOUNDS);
    expect(during).toBe(0);
    expect(core.elements('.far').length).toBe(far);
  });

  it('paints the captions that are still waiting for their frame before it takes the picture', async () => {
    const { renderer, paintCaption, png } = mounted();
    renderer.draw(scene(TWO));
    expect(paintCaption).not.toHaveBeenCalled();
    let paintedBefore = -1;
    png.mockImplementation(() => {
      paintedBefore = paintCaption.mock.calls.length;
      return Promise.resolve(PICTURE);
    });
    await renderer.snapshot(BOUNDS);
    expect(paintedBefore).toBe(2);
  });

  it('shows no selection, and puts it back after', async () => {
    const { renderer, core, png } = mounted();
    renderer.draw(scene(TWO, ['a']));
    expect(core.getElementById('a').data('selected')).toBe(true);
    let during: unknown;
    png.mockImplementation(() => {
      during = core.getElementById('a').data('selected');
      return Promise.resolve(PICTURE);
    });
    await renderer.snapshot(BOUNDS);
    expect(during).toBe(false);
    expect(core.getElementById('a').data('selected')).toBe(true);
  });

  it('holds a drawing that arrives while the picture is made, takes the picture of the earlier scene and applies the drawing after', async () => {
    const { renderer, core, png } = mounted();
    renderer.draw(scene(TWO, ['a']));
    let during: unknown;
    png.mockImplementation(() => {
      renderer.draw(scene(TWO, []));
      during = [core.getElementById('a').data('selected'), core.nodes().length];
      return Promise.resolve(PICTURE);
    });
    await renderer.snapshot(BOUNDS);
    expect(during).toEqual([false, 2]);
    expect(core.getElementById('a').data('selected')).toBe(false);
    renderer.draw(scene(TWO, ['b']));
    expect(core.getElementById('b').data('selected')).toBe(true);
  });

  it('leaves the view on screen as it was, also when the picture fails', async () => {
    const { renderer, core, png } = mounted();
    renderer.draw(scene(TWO, ['a']));
    renderer.show({ zoom: 1.5, x: 40, y: -20 });
    const before = { viewport: renderer.viewport(), positions: [...renderer.positions()], selected: core.getElementById('a').data('selected') };
    png.mockRejectedValue(new Error('canvas too large'));
    await expect(renderer.snapshot(BOUNDS)).rejects.toThrow('canvas too large');
    expect({ viewport: renderer.viewport(), positions: [...renderer.positions()], selected: core.getElementById('a').data('selected') }).toEqual(before);
    png.mockResolvedValue(PICTURE);
    await expect(renderer.snapshot(BOUNDS)).resolves.toBe(PICTURE);
    expect(renderer.viewport()).toEqual(before.viewport);
  });
});
