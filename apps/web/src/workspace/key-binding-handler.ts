import { useEffect } from 'react';
import { useCanvasCommands } from '../canvas/canvas-commands.js';
import { useClientState } from '../state/context.js';
import { useKeyBindingRegistry, type KeyBindingRegistry, type KeyContext } from './key-binding-registry.js';
import { matchesKeys } from './key-spec.js';

/** The attribute that says which part of the page an element belongs to for the keys. */
export const KEY_SCOPE_ATTRIBUTE = 'data-key-scope';

/** A menu, a flyout, a popup or a dialog that holds the focus has the keys: the bindings do not run for a key pressed inside one. */
const HOLDERS = '[role="menu"], [role="dialog"]';
const TYPING = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

function isTyping(target: Element | null): boolean {
  return target !== null && (target.closest(TYPING) !== null || (target instanceof HTMLElement && target.isContentEditable));
}

type Place = 'canvas' | 'workspace' | 'body' | undefined;

function placeOf(target: Element | null): Place {
  if (target === null || target === document.body || target === document.documentElement) return 'body';
  const scope = target.closest(`[${KEY_SCOPE_ATTRIBUTE}]`)?.getAttribute(KEY_SCOPE_ATTRIBUTE);
  return scope === 'canvas' || scope === 'workspace' ? scope : undefined;
}

/** The listener that runs the binding whose keys were pressed, once, and prevents the browser's own action for them. */
export function createKeyListener(registry: KeyBindingRegistry, context: () => KeyContext): (event: KeyboardEvent) => void {
  return (event) => {
    if (event.defaultPrevented || event.isComposing) return;
    const target = event.target instanceof Element ? event.target : null;
    if (isTyping(target) || target?.closest(HOLDERS) != null) return;
    const place = placeOf(target);
    const given = { ...context(), event };
    const binding = registry.view
      .getState()
      .find((candidate) => candidate.specs.some((spec) => matchesKeys(spec, event, registry.platform)) && (candidate.scope === 'canvas' ? place === 'canvas' : place !== undefined) && (candidate.when?.(given) ?? true));
    if (binding === undefined) return;
    if (event.repeat && binding.repeat !== true) {
      event.preventDefault();
      return;
    }
    let unhandled = false;
    try {
      unhandled = binding.run(given) === 'unhandled';
    } finally {
      if (!unhandled) event.preventDefault();
    }
  };
}

/** Listens for the keys while the workspace is shown. */
export function useKeyHandler(): void {
  const registry = useKeyBindingRegistry();
  const state = useClientState();
  const canvas = useCanvasCommands();
  useEffect(() => {
    const listener = createKeyListener(registry, () => ({ state, canvas }));
    document.addEventListener('keydown', listener);
    return () => document.removeEventListener('keydown', listener);
  }, [registry, state, canvas]);
}
