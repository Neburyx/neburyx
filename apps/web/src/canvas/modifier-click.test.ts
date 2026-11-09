import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createCytoscapeRenderer, type RendererCore as Core } from './cytoscape-renderer.js';
import type { RightClick, Scene } from './scene.js';
import type { Click } from './selection-gestures.js';

const scene = (): Scene => ({
  entities: ['a', 'b'].map((id, at) => ({ id, position: { x: at * 100, y: 0 }, look: { iconKey: 'generic' as const, line1: id, line2: 'Type' } })),
  relationships: [{ id: 'ab', from: 'a', to: 'b', look: { aggregate: false, origin: 'stored' as const, label: undefined } }],
  profile: undefined,
  omitted: 0,
  selection: new Set<string>(),
  pinned: new Set<string>(),
  tool: 'select' as const,
  source: null,
  view: 'fit' as const,
});

beforeEach(() => void vi.spyOn(performance, 'now').mockReturnValue(0));
afterEach(() => vi.restoreAllMocks());

// The library's typings take only an event name; the library itself takes an event object that carries the original browser event.
const tapWith = (target: Core | ReturnType<Core['getElementById']>, init: MouseEventInit): void => {
  // @ts-expect-error the typings of `emit` do not allow an event object
  target.emit({ type: 'tap', originalEvent: new MouseEvent('click', init) });
};

const MAC = () => 'mac' as const;
const OTHER = () => 'other' as const;

function drawn(platform: () => 'mac' | 'other', tool: Scene['tool'] = 'select') {
  const clicks: Click[] = [];
  const menus: RightClick[] = [];
  const boxes: unknown[] = [];
  let core: Core | undefined;
  const renderer = createCytoscapeRenderer({ nextFrame: (callback) => callback(), onCore: (made) => void (core = made), platform });
  renderer.mount(undefined, { viewport: () => undefined, click: (click) => void clicks.push(click), box: (box) => void boxes.push(box), contextMenu: (request) => void menus.push(request), move: () => undefined, failed: () => undefined }, undefined);
  renderer.draw({ ...scene(), tool });
  return {
    clicks,
    menus,
    boxes,
    core: (): Core => {
      if (core === undefined) throw new Error('no core');
      return core;
    },
  };
}

describe('a click with ⌘ held on a Mac', () => {
  it('toggles an entity, a relationship and nothing on empty canvas, as a Shift-click does', () => {
    const { clicks, menus, core } = drawn(MAC);
    tapWith(core().getElementById('a'), { metaKey: true });
    tapWith(core().getElementById('ab'), { metaKey: true });
    tapWith(core(), { metaKey: true });
    expect(clicks).toEqual([
      { target: 'a', shift: false, toggle: true },
      { target: 'ab', shift: false, toggle: true },
      { target: undefined, shift: false, toggle: true },
    ]);
    expect(menus).toEqual([]);
  });

  it('keeps a Shift-click as it was', () => {
    const { clicks, core } = drawn(MAC);
    tapWith(core().getElementById('a'), { shiftKey: true });
    expect(clicks).toEqual([{ target: 'a', shift: true }]);
  });
});

describe('a click with Ctrl held on a platform other than a Mac', () => {
  it('toggles an entity, a relationship and nothing on empty canvas, and opens no menu', () => {
    const { clicks, menus, core } = drawn(OTHER);
    tapWith(core().getElementById('a'), { ctrlKey: true });
    tapWith(core().getElementById('ab'), { ctrlKey: true });
    tapWith(core(), { ctrlKey: true });
    expect(clicks).toEqual([
      { target: 'a', shift: false, toggle: true },
      { target: 'ab', shift: false, toggle: true },
      { target: undefined, shift: false, toggle: true },
    ]);
    expect(menus).toEqual([]);
  });

  it('is a plain click with Meta held, and with Meta and Ctrl together', () => {
    const { clicks, menus, core } = drawn(OTHER);
    tapWith(core().getElementById('a'), { metaKey: true });
    tapWith(core().getElementById('a'), { metaKey: true, ctrlKey: true });
    expect(clicks).toEqual([{ target: 'a', shift: false }, { target: 'a', shift: false }]);
    expect(menus).toEqual([]);
  });
});

describe('a click with Ctrl held on a Mac (the system\'s right-click)', () => {
  // On macOS the press is a left-button press with `ctrlKey`; the library sends `tap` for it and `cxttap` only for the right button.
  it('asks for the menu of an entity, of a relationship and of the canvas at the pointer, and does not click', () => {
    const { clicks, menus, core } = drawn(MAC);
    tapWith(core().getElementById('a'), { ctrlKey: true, button: 0, clientX: 11, clientY: 12 });
    tapWith(core().getElementById('ab'), { ctrlKey: true, button: 0, clientX: 21, clientY: 22 });
    tapWith(core(), { ctrlKey: true, button: 0, clientX: 31, clientY: 32 });
    expect(menus).toEqual([
      { target: { kind: 'node', key: 'a' }, x: 11, y: 12 },
      { target: { kind: 'relationship', key: 'ab' }, x: 21, y: 22 },
      { target: undefined, x: 31, y: 32 },
    ]);
    expect(clicks).toEqual([]);
  });

  it('is a menu, not a toggle, with ⌘ held as well', () => {
    const { clicks, menus, core } = drawn(MAC);
    tapWith(core().getElementById('a'), { ctrlKey: true, metaKey: true, clientX: 1, clientY: 2 });
    expect(menus).toEqual([{ target: { kind: 'node', key: 'a' }, x: 1, y: 2 }]);
    expect(clicks).toEqual([]);
  });

  it('opens the menu in the mode box and in the mode pan as a right-click does', () => {
    for (const tool of ['box', 'pan'] as const) {
      const { clicks, menus, core } = drawn(MAC, tool);
      tapWith(core().getElementById('a'), { ctrlKey: true, clientX: 3, clientY: 4 });
      expect(menus).toEqual([{ target: { kind: 'node', key: 'a' }, x: 3, y: 4 }]);
      expect(clicks).toEqual([]);
    }
  });

  it('still opens the menu for a right-click, on a Mac and on any other platform', () => {
    for (const platform of [MAC, OTHER]) {
      const { menus, core } = drawn(platform);
      // @ts-expect-error the typings of `emit` do not allow an event object
      core().getElementById('a').emit({ type: 'cxttap', originalEvent: new MouseEvent('contextmenu', { clientX: 5, clientY: 6 }) });
      expect(menus).toEqual([{ target: { kind: 'node', key: 'a' }, x: 5, y: 6 }]);
    }
  });
});

describe('a press with the toggle modifier held', () => {
  it('does not start a box in the mode select (only Shift does)', () => {
    const { boxes, core } = drawn(OTHER);
    const press = (type: string, at: { x: number; y: number }): void => {
      // @ts-expect-error the typings of `emit` do not allow an event object
      core().emit({ type, renderedPosition: at, originalEvent: new MouseEvent('mousedown', { ctrlKey: true }) });
    };
    press('tapstart', { x: -10, y: -10 });
    press('tapend', { x: 120, y: 40 });
    expect(boxes).toEqual([]);
  });
});

describe('an entity drag that starts with the toggle modifier held', () => {
  it('moves the entity and reports where it was left, as an unmodified drag does', () => {
    const moves: Array<{ readonly id: string; readonly position: { readonly x: number; readonly y: number } }> = [];
    let core: Core | undefined;
    const renderer = createCytoscapeRenderer({ nextFrame: (callback) => callback(), onCore: (made) => void (core = made), platform: OTHER, canvasSize: () => ({ width: 1000, height: 800 }) });
    renderer.mount(undefined, { viewport: () => undefined, click: () => undefined, box: () => undefined, contextMenu: () => undefined, move: (move) => void moves.push(move), failed: () => undefined }, undefined);
    renderer.draw(scene());
    const entity = core?.getElementById('a');
    if (entity === undefined) throw new Error('no entity');
    const held = new MouseEvent('mousedown', { ctrlKey: true });
    // @ts-expect-error the typings of `emit` do not allow an event object
    entity.emit({ type: 'grab', originalEvent: held });
    entity.position({ x: 120, y: -40 });
    entity.emit('drag');
    // @ts-expect-error the typings of `emit` do not allow an event object
    entity.emit({ type: 'dragfree', renderedPosition: { x: 500, y: 400 }, originalEvent: held });
    entity.emit('free');
    expect(moves).toEqual([{ id: 'a', position: { x: 120, y: -40 } }]);
  });
});
