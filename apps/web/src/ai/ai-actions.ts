import { createContext, useContext } from 'react';
import { createStore, readable, type ReadableStore } from '../state/store.js';

export const AI_ACTION_NAMES = ['ask', 'summarize'] as const;

export type AiActionName = (typeof AI_ACTION_NAMES)[number];

export type AiActionHandler = () => void;

export class AiActionError extends Error {
  readonly code = 'AI_ACTION_TAKEN';

  constructor(readonly action: AiActionName) {
    super(`AI_ACTION_TAKEN: ${action}`);
    this.name = 'AiActionError';
  }
}

export type AiActionHandlers = ReadonlyMap<AiActionName, AiActionHandler>;

export interface AiActions {
  readonly view: ReadableStore<AiActionHandlers>;
  /** Puts the handler of an action in place and returns the function that takes it out again. An action that has a handler refuses a second one. */
  register(action: AiActionName, handler: AiActionHandler): () => void;
}

export function createAiActions(): AiActions {
  const store = createStore<AiActionHandlers>(new Map());
  const registrations = new Map<AiActionName, symbol>();
  return {
    view: readable(store),
    register(action, handler) {
      const current = store.getState();
      if (current.has(action)) throw new AiActionError(action);
      const registration = Symbol(action);
      registrations.set(action, registration);
      store.setState(new Map(current).set(action, handler));
      return () => {
        if (registrations.get(action) !== registration) return;
        registrations.delete(action);
        const next = new Map(store.getState());
        next.delete(action);
        store.setState(next);
      };
    },
  };
}

/** The handlers of the page; the features behind Ask and Summarize register theirs here. */
export const aiActions = createAiActions();

export const registerAiAction: AiActions['register'] = (action, handler) => aiActions.register(action, handler);

const AiActionsContext = createContext<AiActions>(aiActions);

export const AiActionsProvider = AiActionsContext.Provider;

export function useAiActions(): AiActions {
  return useContext(AiActionsContext);
}
