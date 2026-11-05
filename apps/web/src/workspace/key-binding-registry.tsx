import { createContext, useContext, type ReactNode } from 'react';
import type { CanvasCommands } from '../canvas/canvas-commands.js';
import type { ClientState } from '../state/client-state.js';
import { createStore, readable, useStoreSelector, type ReadableStore } from '../state/store.js';
import { detectPlatform, parseKeys, sameKeys, showKeys, type KeySpec, type Platform } from './key-spec.js';

export type KeyGroup = 'tools' | 'selection' | 'actions' | 'view';

/** `workspace` keys work with the focus anywhere in the workspace or on the page body; `canvas` keys only while the canvas holds the focus, and are passed through to the browser anywhere else. */
export type KeyScope = 'workspace' | 'canvas';

/** What a binding's command is given when its keys are pressed. */
export interface KeyContext {
  readonly state: ClientState;
  /** Absent while no renderer is running. */
  readonly canvas: CanvasCommands | undefined;
  /** The key press that runs the binding; absent when a command is run some other way. */
  readonly event?: KeyboardEvent | undefined;
}

export interface KeyBindingEntry {
  readonly id: string;
  /** The alternative keys that run it, as `mod+shift+i`, `shift+f10` or `escape` (`mod` is the platform's own modifier). */
  readonly keys: readonly string[];
  readonly label: string;
  readonly group: KeyGroup;
  readonly order: number;
  readonly scope: KeyScope;
  /** The binding is in force only while this is true; bindings that both have one may share keys, and the first whose test passes runs. */
  readonly when?: (context: KeyContext) => boolean;
  /** Runs again for each repeat of a key held down; without it only the first press runs. */
  readonly repeat?: boolean;
  /** How the keys read on a platform when listing them one by one would be a row of near-duplicates, such as the four arrows as one chip. */
  readonly shownAs?: Readonly<Record<Platform, readonly string[]>>;
  /** Returns `'unhandled'` when the key was not for it, which leaves the browser's own action alone and runs nothing else. */
  readonly run: (context: KeyContext) => void | 'unhandled';
}

export interface RegisteredKeyBinding extends KeyBindingEntry {
  readonly registration: number;
  readonly specs: readonly KeySpec[];
  /** The keys as a person sees them on this platform, one text for each of `keys`. */
  readonly shown: readonly string[];
}

export class KeyBindingError extends Error {
  readonly code: 'BINDING_TAKEN' | 'KEYS_TAKEN';

  constructor(code: 'BINDING_TAKEN' | 'KEYS_TAKEN', id: string) {
    super(code === 'BINDING_TAKEN' ? `a key binding named ${id} is already registered` : `the keys of ${id} are already bound`);
    this.name = 'KeyBindingError';
    this.code = code;
  }
}

export interface KeyBindingRegistry {
  readonly platform: Platform;
  /** The bindings in the order of their `order`, ties in the order registered. */
  readonly view: ReadableStore<readonly RegisteredKeyBinding[]>;
  /** Returns a function that takes exactly this binding out. */
  readonly register: (entry: KeyBindingEntry) => () => void;
}

export function createKeyBindingRegistry(platform: Platform = detectPlatform()): KeyBindingRegistry {
  const store = createStore<readonly RegisteredKeyBinding[]>([]);
  const registrations: Array<{ readonly token: symbol; readonly binding: RegisteredKeyBinding }> = [];
  let registered = 0;
  const publish = (): void => {
    store.setState(registrations.map(({ binding }) => binding).sort((a, b) => a.order - b.order || a.registration - b.registration));
  };
  return {
    platform,
    view: readable(store),
    register(entry) {
      if (registrations.some(({ binding }) => binding.id === entry.id)) throw new KeyBindingError('BINDING_TAKEN', entry.id);
      const specs = entry.keys.map(parseKeys);
      const shares = ({ binding }: { readonly binding: RegisteredKeyBinding }): boolean => binding.specs.some((taken) => specs.some((spec) => sameKeys(taken, spec))) && (binding.when === undefined || entry.when === undefined);
      if (registrations.some(shares)) throw new KeyBindingError('KEYS_TAKEN', entry.id);
      const token = Symbol(entry.id);
      registered += 1;
      registrations.push({ token, binding: { ...entry, registration: registered, specs, shown: entry.shownAs?.[platform] ?? specs.map((spec) => showKeys(spec, platform)) } });
      publish();
      return () => {
        const at = registrations.findIndex((registration) => registration.token === token);
        if (at === -1) return;
        registrations.splice(at, 1);
        publish();
      };
    },
  };
}

const KeyBindingContext = createContext<KeyBindingRegistry | undefined>(undefined);

export function KeyBindingsProvider({ registry, children }: { readonly registry: KeyBindingRegistry; readonly children: ReactNode }) {
  return <KeyBindingContext.Provider value={registry}>{children}</KeyBindingContext.Provider>;
}

export function useKeyBindingRegistry(): KeyBindingRegistry {
  const registry = useContext(KeyBindingContext);
  if (registry === undefined) throw new Error('the key bindings are not provided');
  return registry;
}

export function useKeyBindings(): readonly RegisteredKeyBinding[] {
  return useStoreSelector(useKeyBindingRegistry().view, (bindings) => bindings);
}
