import { createContext, useContext, type ComponentType, type ReactNode } from 'react';
import type { ClientState } from '../state/client-state.js';
import { createStore, readable, useStoreSelector, type ReadableStore } from '../state/store.js';
import { PANEL_INITIAL_WIDTH } from './panel-limits.js';

export type PanelPlacement =
  | { readonly kind: 'dock' }
  /** Shown over the canvas, `top` px below its top and the gap from the given side. */
  | { readonly kind: 'floating'; readonly side: 'left' | 'right'; readonly top: number };

export interface PanelEntry {
  readonly id: string;
  readonly title: string;
  readonly placement: PanelPlacement;
  /** The width when none was stored; the panel is drawn within the limits of the moment. */
  readonly initialWidth?: number;
  readonly content: ComponentType;
}

/** A panel as listed: the registration number is new each time a panel is registered, also for an ID registered before. */
export interface RegisteredPanel extends PanelEntry {
  readonly initialWidth: number;
  readonly registration: number;
}

export type PanelErrorCode = 'PANEL_TAKEN' | 'DOCK_TAKEN';

export class PanelError extends Error {
  constructor(
    readonly code: PanelErrorCode,
    readonly panelId: string,
  ) {
    super(`${code}: ${panelId}`);
    this.name = 'PanelError';
  }
}

export interface PanelRegistry {
  /** In registration order, so a panel registered later is layered above one registered earlier. */
  readonly view: ReadableStore<readonly RegisteredPanel[]>;
  /** Adds a panel and returns the function that takes out that registration only. An ID registered, or a second panel for the dock, is refused. */
  register(entry: PanelEntry): () => void;
}

export interface PanelRegistryOptions {
  /** Called when a registration is taken out, with the panel as it was registered; not called for a remover that is stale. */
  readonly onRemoved?: (panel: RegisteredPanel) => void;
}

export function createPanelRegistry(options: PanelRegistryOptions = {}): PanelRegistry {
  const store = createStore<readonly RegisteredPanel[]>([]);
  const registrations: Array<{ readonly token: symbol; readonly panel: RegisteredPanel }> = [];
  let registered = 0;
  return {
    view: readable(store),
    register(entry) {
      if (registrations.some(({ panel }) => panel.id === entry.id)) throw new PanelError('PANEL_TAKEN', entry.id);
      if (entry.placement.kind === 'dock' && registrations.some(({ panel }) => panel.placement.kind === 'dock')) throw new PanelError('DOCK_TAKEN', entry.id);
      const token = Symbol(entry.id);
      registered += 1;
      registrations.push({ token, panel: { ...entry, initialWidth: entry.initialWidth ?? PANEL_INITIAL_WIDTH, registration: registered } });
      store.setState(registrations.map(({ panel }) => panel));
      return () => {
        const at = registrations.findIndex((registration) => registration.token === token);
        const removed = registrations[at];
        if (removed === undefined) return;
        registrations.splice(at, 1);
        store.setState(registrations.map(({ panel }) => panel));
        options.onRemoved?.(removed.panel);
      };
    },
  };
}

/** A registry that lets go of a panel's collapsed state when the panel is taken out, so one registered again opens expanded. */
export function createPanelRegistryFor(state: ClientState): PanelRegistry {
  return createPanelRegistry({ onRemoved: (panel) => state.presentation.clearPanelCollapsed(panel.id, panel.registration) });
}

const PanelsContext = createContext<PanelRegistry | undefined>(undefined);

export function PanelsProvider({ registry, children }: { readonly registry: PanelRegistry; readonly children: ReactNode }) {
  return <PanelsContext.Provider value={registry}>{children}</PanelsContext.Provider>;
}

export function usePanelRegistry(): PanelRegistry {
  const registry = useContext(PanelsContext);
  if (registry === undefined) throw new Error('the panels are not provided');
  return registry;
}

export function usePanels(): readonly RegisteredPanel[] {
  return useStoreSelector(usePanelRegistry().view, (panels) => panels);
}
