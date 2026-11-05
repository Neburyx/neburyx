import { act, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clientWith, me, renderApp, source, stubFactory, builtInKeyBindings } from '../test-utils.js';
import { createClientState } from '../state/client-state.js';
import { createKeyBindingRegistry, type KeyBindingEntry, type KeyBindingRegistry } from './key-binding-registry.js';
import { createKeyListener, KEY_SCOPE_ATTRIBUTE } from './key-binding-handler.js';
import type { Platform } from './key-spec.js';

const noContext = () => ({ state: createClientState(), canvas: undefined });

interface Rig {
  readonly registry: KeyBindingRegistry;
  readonly runs: string[];
  readonly add: (id: string, keys: readonly string[], overrides?: Partial<KeyBindingEntry>) => void;
  readonly button: HTMLButtonElement;
  readonly canvas: HTMLElement;
  readonly outside: HTMLButtonElement;
  readonly input: HTMLInputElement;
  readonly area: HTMLTextAreaElement;
  readonly select: HTMLSelectElement;
  readonly editable: HTMLElement;
}

let detach: (() => void) | undefined;

function rig(platform: Platform = 'other'): Rig {
  const registry = createKeyBindingRegistry(platform);
  const runs: string[] = [];
  const workspace = document.createElement('div');
  workspace.setAttribute(KEY_SCOPE_ATTRIBUTE, 'workspace');
  const button = document.createElement('button');
  const canvas = document.createElement('div');
  canvas.setAttribute(KEY_SCOPE_ATTRIBUTE, 'canvas');
  canvas.tabIndex = 0;
  const input = document.createElement('input');
  const area = document.createElement('textarea');
  const select = document.createElement('select');
  const editable = document.createElement('div');
  editable.setAttribute('contenteditable', 'true');
  workspace.append(button, canvas, input, area, select, editable);
  const outside = document.createElement('button');
  document.body.append(workspace, outside);
  const listener = createKeyListener(registry, noContext);
  document.addEventListener('keydown', listener);
  detach = () => {
    document.removeEventListener('keydown', listener);
    workspace.remove();
    outside.remove();
  };
  return {
    registry,
    runs,
    add: (id, keys, overrides = {}) => void registry.register({ id, keys, label: id, group: 'tools', order: 10, scope: 'workspace', run: () => void runs.push(id), ...overrides }),
    button,
    canvas,
    outside,
    input,
    area,
    select,
    editable,
  };
}

function press(target: Element, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

afterEach(() => {
  detach?.();
  detach = undefined;
  cleanup();
});

describe('the keys of a workspace binding', () => {
  it('run it once with the focus on a control in the workspace and on the page body, and the browser\'s own action for the key is prevented', () => {
    const { add, button, runs } = rig();
    add('fit', ['mod+0']);
    expect(press(button, '0', { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(press(document.body, '0', { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(runs).toEqual(['fit', 'fit']);
  });

  it('leave a key no binding has alone, run nothing for it, and do not run for a control outside the workspace', () => {
    const { add, button, outside, runs } = rig();
    add('fit', ['mod+0']);
    expect(press(button, 'q').defaultPrevented).toBe(false);
    expect(press(outside, '0', { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(runs).toEqual([]);
  });

  it('run a binding from the canvas, which is inside the workspace', () => {
    const { add, canvas, runs } = rig();
    add('fit', ['mod+0']);
    press(canvas, '0', { ctrlKey: true });
    expect(runs).toEqual(['fit']);
  });
});

describe('the keys of a canvas binding', () => {
  it('run it with the canvas holding the focus, and pass the key through to the browser everywhere else', () => {
    const { add, button, canvas, runs } = rig();
    add('move', ['arrowleft'], { scope: 'canvas' });
    expect(press(canvas, 'ArrowLeft').defaultPrevented).toBe(true);
    for (const other of [button, document.body]) expect(press(other, 'ArrowLeft').defaultPrevented).toBe(false);
    expect(runs).toEqual(['move']);
  });
});

describe('the modifier of a binding', () => {
  it.each([
    ['mac', { metaKey: true }, { ctrlKey: true }, '⌘0'],
    ['other', { ctrlKey: true }, { metaKey: true }, 'Ctrl+0'],
  ] as const)('is ⌘ on macOS and Ctrl elsewhere: on %s the other one does nothing, and the text is %s', (platform, right, wrong, text) => {
    const { add, button, registry, runs } = rig(platform);
    add('fit', ['mod+0']);
    expect(press(button, '0', wrong).defaultPrevented).toBe(false);
    expect(runs).toEqual([]);
    expect(press(button, '0', right).defaultPrevented).toBe(true);
    expect(runs).toEqual(['fit']);
    expect(registry.view.getState()[0]?.shown).toEqual([text]);
  });

  it('does not fire for a modifier the binding does not name, and counts Shift for a letter', () => {
    const { add, button, runs } = rig();
    add('select', ['v']);
    add('paths', ['shift+p']);
    add('pin', ['p']);
    add('copy-properties', ['mod+shift+c']);
    add('copy-id', ['mod+c']);
    press(button, 'v', { altKey: true });
    expect(runs).toEqual([]);
    press(button, 'P', { shiftKey: true });
    press(button, 'p');
    press(button, 'C', { ctrlKey: true, shiftKey: true });
    press(button, 'c', { ctrlKey: true });
    expect(runs).toEqual(['paths', 'pin', 'copy-properties', 'copy-id']);
  });

  it('does not count Shift for a symbol some layouts type with it', () => {
    const { add, button, runs } = rig();
    add('sheet', ['mod+/']);
    press(button, '/', { ctrlKey: true, shiftKey: true });
    expect(runs).toEqual(['sheet']);
  });
});

describe('typing in a field', () => {
  it.each(['input', 'area', 'select', 'editable'] as const)('lets a %s have every key: nothing runs and the browser\'s own action is not prevented, and the keys work again after the focus leaves', (name) => {
    const handles = rig();
    handles.add('fit', ['mod+0']);
    handles.add('select', ['v']);
    const field = handles[name];
    expect(press(field, '0', { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(press(field, 'v').defaultPrevented).toBe(false);
    expect(handles.runs).toEqual([]);
    press(handles.button, 'v');
    expect(handles.runs).toEqual(['select']);
  });

  it('lets the field have ⌘A, which selects its text', () => {
    const { add, input, runs } = rig();
    add('select-all', ['mod+a']);
    expect(press(input, 'a', { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(runs).toEqual([]);
  });
});

describe('a key held down', () => {
  it('runs a binding once, and prevents the browser\'s action on every repeat, unless the binding repeats', () => {
    const { add, button, runs } = rig();
    add('once', ['a']);
    add('again', ['b'], { repeat: true });
    expect(press(button, 'a').defaultPrevented).toBe(true);
    expect(press(button, 'a', { repeat: true }).defaultPrevented).toBe(true);
    press(button, 'b');
    press(button, 'b', { repeat: true });
    press(button, 'b', { repeat: true });
    expect(runs).toEqual(['once', 'again', 'again', 'again']);
  });
});

describe('a binding that cannot run its command', () => {
  let errors: unknown[] = [];
  const onError = (event: ErrorEvent): void => {
    errors.push(event.error);
    event.preventDefault();
  };
  beforeEach(() => {
    errors = [];
    window.addEventListener('error', onError);
  });
  afterEach(() => window.removeEventListener('error', onError));

  it('lets its error reach the window and still prevents the browser\'s action, and the next key runs its binding', () => {
    const { add, button, runs } = rig();
    add('broken', ['a'], { run: () => { throw new Error('the command failed'); } });
    add('fine', ['b']);
    const event = press(button, 'a');
    expect(event.defaultPrevented).toBe(true);
    expect(errors.map((error) => (error instanceof Error ? error.message : error))).toEqual(['the command failed']);
    press(button, 'b');
    expect(runs).toEqual(['fine']);
  });

  it('leaves the browser\'s action alone when the command says the key was not for it', () => {
    const { add, button } = rig();
    add('tab', ['tab'], { run: () => 'unhandled' });
    expect(press(button, 'Tab').defaultPrevented).toBe(false);
  });
});

describe('the fit key in the workspace', () => {
  const client = clientWith({ me: me(), sources: [source('a')] });

  it('fits the view as the Fit control does, from the page body, a control and the canvas', async () => {
    const factory = stubFactory();
    renderApp('/explore', client, createClientState(), undefined, factory.create);
    await act(async () => void (await Promise.resolve()));
    const renderer = factory.made[0];
    expect(renderer?.fits).toBe(0);
    for (const target of [document.body, document.querySelector('button') ?? document.body]) act(() => void press(target, '0', { metaKey: true }));
    expect(renderer?.fits).toBe(2);
  });

  it('does nothing and throws nothing when no renderer is running to fit', async () => {
    const factory = stubFactory({ failCreate: true });
    renderApp('/explore', client, createClientState(), undefined, factory.create);
    await act(async () => void (await Promise.resolve()));
    expect(() => act(() => void press(document.body, '0', { metaKey: true }))).not.toThrow();
  });

  it('stops listening when the workspace is gone, and runs its binding exactly once when it is shown again', async () => {
    const factory = stubFactory();
    const keyBindings = builtInKeyBindings();
    const first = renderApp('/explore', client, createClientState(), undefined, factory.create, undefined, undefined, undefined, undefined, keyBindings);
    await act(async () => void (await Promise.resolve()));
    first.unmount();
    act(() => void press(document.body, '0', { metaKey: true }));
    expect(factory.made.map((renderer) => renderer.fits)).toEqual([0]);
    const again = renderApp('/explore', client, createClientState(), undefined, factory.create, undefined, undefined, undefined, undefined, keyBindings);
    await act(async () => void (await Promise.resolve()));
    act(() => void press(document.body, '0', { metaKey: true }));
    expect(factory.made.map((renderer) => renderer.fits)).toEqual([0, 1]);
    again.unmount();
  });
});

describe('bindings that share keys by their conditions', () => {
  it('run the first whose condition holds, and pass the key through when none does', () => {
    const { add, button, runs } = rig();
    let mode = 'a';
    add('when-a', ['enter'], { when: () => mode === 'a' });
    add('when-b', ['enter'], { when: () => mode === 'b', order: 20 });
    expect(press(button, 'Enter').defaultPrevented).toBe(true);
    mode = 'b';
    expect(press(button, 'Enter').defaultPrevented).toBe(true);
    mode = 'c';
    expect(press(button, 'Enter').defaultPrevented).toBe(false);
    expect(runs).toEqual(['when-a', 'when-b']);
  });

  it('look at the scope too: a canvas binding whose condition holds does not hide a workspace binding with the same keys from the rest of the page', () => {
    const { add, button, canvas, runs } = rig();
    add('canvas-one', ['escape'], { scope: 'canvas', when: () => true });
    add('workspace-one', ['escape'], { when: () => true, order: 20 });
    press(canvas, 'Escape');
    press(button, 'Escape');
    expect(runs).toEqual(['canvas-one', 'workspace-one']);
  });
});

describe('the keys that open the context menu', () => {
  it('run on the canvas only, and pass through anywhere else, in a text field and on the page body', () => {
    const { add, button, canvas, input, area, editable, runs } = rig();
    add('menu', ['contextmenu', 'shift+f10'], { scope: 'canvas' });
    expect(press(canvas, 'ContextMenu').defaultPrevented).toBe(true);
    expect(press(canvas, 'F10', { shiftKey: true }).defaultPrevented).toBe(true);
    for (const other of [button, input, area, editable, document.body]) {
      expect(press(other, 'ContextMenu').defaultPrevented).toBe(false);
      expect(press(other, 'F10', { shiftKey: true }).defaultPrevented).toBe(false);
    }
    expect(runs).toEqual(['menu', 'menu']);
  });
});

