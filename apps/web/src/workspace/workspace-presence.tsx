import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { createStore, type ReadableStore, readable } from '../state/store.js';

export interface WorkspacePresence {
  readonly shown: ReadableStore<boolean>;
  readonly enter: () => () => void;
}

export function createWorkspacePresence(): WorkspacePresence {
  const count = createStore(0);
  const shown = createStore(false);
  return {
    shown: readable(shown),
    enter() {
      count.setState(count.getState() + 1);
      shown.setState(true);
      return () => {
        count.setState(count.getState() - 1);
        shown.setState(count.getState() > 0);
      };
    },
  };
}

const PresenceContext = createContext<WorkspacePresence | undefined>(undefined);

export function WorkspacePresenceProvider({ presence, children }: { readonly presence: WorkspacePresence; readonly children: ReactNode }) {
  return <PresenceContext.Provider value={presence}>{children}</PresenceContext.Provider>;
}

export function useWorkspacePresence(): WorkspacePresence | undefined {
  return useContext(PresenceContext);
}

export function useWorkspaceMark(): void {
  const presence = useWorkspacePresence();
  useEffect(() => presence?.enter(), [presence]);
}
