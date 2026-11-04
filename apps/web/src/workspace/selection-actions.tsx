import { createContext, useContext, type ReactNode } from 'react';
import { createStore, readable, useStoreSelector, type ReadableStore } from '../state/store.js';

export interface SelectionAction {
  readonly id: string;
  readonly label: string;
  readonly icon: ReactNode;
  /** Receives the keys of the selected items in selection order. */
  readonly run: (selection: readonly string[]) => void;
}

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
  const publish = (): void => store.setState(registrations.map((registration) => registration.action));
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

export function useSelectionActionRegistry(): SelectionActionRegistry {
  const registry = useContext(SelectionActionsContext);
  if (registry === undefined) throw new Error('the selection actions are not provided');
  return registry;
}

export function useSelectionActions(): readonly SelectionAction[] {
  return useStoreSelector(useSelectionActionRegistry().view, (actions) => actions);
}
