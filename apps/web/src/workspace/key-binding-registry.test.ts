import { describe, expect, it } from 'vitest';
import { createKeyBindingRegistry, KeyBindingError, type KeyBindingEntry } from './key-binding-registry.js';

const binding = (id: string, keys: readonly string[], order = 10, overrides: Partial<KeyBindingEntry> = {}): KeyBindingEntry => ({ id, keys, label: id, group: 'tools', order, scope: 'workspace', run: () => undefined, ...overrides });
const ids = (registry: ReturnType<typeof createKeyBindingRegistry>): string[] => registry.view.getState().map((entry) => entry.id);

describe('the key binding registry', () => {
  it('lists the bindings by order and then by registration, with the keys as a person sees them', () => {
    const registry = createKeyBindingRegistry('mac');
    registry.register(binding('late', ['mod+b'], 30));
    registry.register(binding('first', ['mod+a'], 10));
    registry.register(binding('same', ['mod+c'], 10));
    expect(ids(registry)).toEqual(['first', 'same', 'late']);
    expect(registry.view.getState().map((entry) => entry.shown)).toEqual([['⌘A'], ['⌘C'], ['⌘B']]);
  });

  it('shows the same bindings with Ctrl on a platform that is not macOS, and keeps every alternative of a binding', () => {
    const registry = createKeyBindingRegistry('other');
    registry.register(binding('menu', ['contextmenu', 'shift+f10']));
    expect(registry.view.getState()[0]?.shown).toEqual(['Menu', 'Shift+F10']);
  });

  it('takes out exactly the binding it was given, and only once', () => {
    const registry = createKeyBindingRegistry('other');
    const removeA = registry.register(binding('a', ['a']));
    registry.register(binding('b', ['b']));
    removeA();
    expect(ids(registry)).toEqual(['b']);
    removeA();
    expect(ids(registry)).toEqual(['b']);
    registry.register(binding('a', ['a']));
    expect(ids(registry)).toEqual(['b', 'a']);
  });

  it('refuses a second binding with the same id, with `BINDING_TAKEN`, and leaves the first alone', () => {
    const registry = createKeyBindingRegistry('other');
    registry.register(binding('a', ['a']));
    let error: unknown;
    try {
      registry.register(binding('a', ['b']));
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(KeyBindingError);
    expect(error instanceof KeyBindingError ? error.code : '').toBe('BINDING_TAKEN');
    expect(registry.view.getState().map((entry) => entry.keys)).toEqual([['a']]);
  });

  it('refuses keys that are bound already, with `KEYS_TAKEN`, also when only one alternative clashes, but not the same letter with Shift', () => {
    const registry = createKeyBindingRegistry('other');
    registry.register(binding('a', ['p', 'mod+k']));
    for (const keys of [['p'], ['x', 'mod+k']]) {
      let code = '';
      try {
        registry.register(binding('b', keys));
      } catch (thrown) {
        code = thrown instanceof KeyBindingError ? thrown.code : 'other';
      }
      expect(code, keys.join()).toBe('KEYS_TAKEN');
    }
    expect(() => registry.register(binding('c', ['shift+p']))).not.toThrow();
    expect(ids(registry)).toEqual(['a', 'c']);
  });

  it('tells a subscriber when the list changes', () => {
    const registry = createKeyBindingRegistry('other');
    const seen: number[] = [];
    registry.view.subscribe(() => seen.push(registry.view.getState().length));
    const remove = registry.register(binding('a', ['a']));
    remove();
    expect(seen).toEqual([1, 0]);
  });

  it('lets bindings share keys when each has a condition, and refuses them when either has none', () => {
    const registry = createKeyBindingRegistry('other');
    registry.register(binding('on', ['enter', 'space'], 10, { when: () => true }));
    registry.register(binding('off', ['enter'], 20, { when: () => false }));
    expect(ids(registry)).toEqual(['on', 'off']);
    for (const [name, first, second] of [
      ['a guarded binding then a plain one', binding('first', ['enter'], 10, { when: () => true }), binding('second', ['enter'], 20)],
      ['a plain binding then a guarded one', binding('first', ['enter']), binding('second', ['enter'], 20, { when: () => true })],
    ] as const) {
      const other = createKeyBindingRegistry('other');
      other.register(first);
      let code = '';
      try {
        other.register(second);
      } catch (thrown) {
        code = thrown instanceof KeyBindingError ? thrown.code : 'other';
      }
      expect(code, name).toBe('KEYS_TAKEN');
    }
  });
});
