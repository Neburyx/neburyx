import { createContext, useContext, type ReactNode } from 'react';
import type { ClientState } from '../state/client-state.js';
import { createStore, readable, useStoreSelector, type ReadableStore } from '../state/store.js';

export interface SelectionAction {
  readonly id: string;
  /** The text of the button; a function reads it from the drawn selected entities and the state each time the bar is drawn (the bar redraws when the pins change). */
  readonly label: string | ((selection: readonly string[], state: ClientState) => string);
  readonly icon: ReactNode;
  /** Where the action stands on the bar, lowest first; one without sorts after those that have one, in the order registered. */
  readonly order?: number;
  /** Receives the keys of the selected items in selection order; text it returns is shown beside the action. */
  readonly run: (selection: readonly string[]) => void | string;
}

/** Where each action stands on the bar (ui-spec §8.3): Expand, Paths between, Group, Pin, Hide, then Copy IDs, which the bar itself draws last. */
export const SELECTION_ACTION_ORDER = { expand: 10, pathsBetween: 20, group: 30, pin: 40, hide: 50 } as const;

export class ActionError extends Error {
  readonly code = 'ACTION_TAKEN';

  constructor(readonly actionId: string) {
    super(`ACTION_TAKEN: ${actionId}`);
    this.name = 'ActionError';
  }
}

export interface SelectionActionRegistry {
  readonly view: ReadableStore<readonly SelectionAction[]>;
  /** Adds an action after those registered before it and returns the function that takes it out again. An ID already registered is refused. */
  register(action: SelectionAction): () => void;
}

export function createSelectionActionRegistry(): SelectionActionRegistry {
  const store = createStore<readonly SelectionAction[]>([]);
  const registrations: Array<{ readonly token: symbol; readonly action: SelectionAction }> = [];
  const publish = (): void => store.setState(registrations.map((registration, at) => ({ action: registration.action, at })).sort((a, b) => (a.action.order ?? Infinity) - (b.action.order ?? Infinity) || a.at - b.at).map(({ action }) => action));
  return {
    view: readable(store),
    register(action) {
      if (registrations.some((registration) => registration.action.id === action.id)) throw new ActionError(action.id);
      const token = Symbol(action.id);
      registrations.push({ token, action });
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

const SelectionActionsContext = createContext<SelectionActionRegistry | undefined>(undefined);

export function SelectionActionsProvider({ registry, children }: { readonly registry: SelectionActionRegistry; readonly children: ReactNode }) {
  return <SelectionActionsContext.Provider value={registry}>{children}</SelectionActionsContext.Provider>;
}

/** The registry when one is provided, and nothing in a part of the app drawn without one. */
export function useSelectionActionRegistryWhenProvided(): SelectionActionRegistry | undefined {
  return useContext(SelectionActionsContext);
}

export function useSelectionActionRegistry(): SelectionActionRegistry {
  const registry = useContext(SelectionActionsContext);
  if (registry === undefined) throw new Error('the selection actions are not provided');
  return registry;
}

export function useSelectionActions(): readonly SelectionAction[] {
  return useStoreSelector(useSelectionActionRegistry().view, (actions) => actions);
}
