import { createContext, useContext } from 'react';
import type { AssistantFailureKind, AssistantRefusalCause, AskAnswer } from '@neburyx/contracts';
import type { ApiFailure } from '../api/client.js';
import type { AddedOutcome } from '../patterns/add-to-graph.js';
import type { Answered, Refused } from '../ask/ask-session.js';
import { createStore, type Store } from '../state/store.js';

export type Retry =
  | { readonly kind: 'message'; readonly text: string }
  | { readonly kind: 'continue'; readonly intent: string; readonly entities: Answered['entities']; readonly token: string; readonly heavy: Answered };

export type Failure =
  | { readonly kind: 'unavailable'; readonly why: AssistantFailureKind; readonly readStarted: boolean; readonly retryAfterSeconds: number | undefined; readonly until: number | undefined }
  | { readonly kind: 'too-large'; readonly sentence: string }
  | { readonly kind: 'request'; readonly failure: ApiFailure; readonly until: number | undefined }
  | { readonly kind: 'continue-invalid' };

export type Outcome =
  | { readonly kind: 'pending'; readonly call: 'message' | 'continue' }
  | { readonly kind: 'refuse'; readonly cause: AssistantRefusalCause; readonly sentence: string }
  | { readonly kind: 'not-answered'; readonly sentence: string }
  | { readonly kind: 'answered'; readonly answer: Answered; readonly added: AddedOutcome | undefined; readonly step: Step | undefined; readonly coverage: string | undefined }
  | { readonly kind: 'ask-refused'; readonly refused: Refused }
  | { readonly kind: 'heavy'; readonly answer: Answered; readonly token: string }
  | { readonly kind: 'failed'; readonly failure: Failure; readonly retry: Retry };

export interface Step {
  readonly intent: string;
  readonly rows: number;
  readonly outcome: 'complete' | 'partial';
}

export interface Turn {
  readonly id: number;
  readonly message: string;
  readonly outcome: Outcome;
}

type Notice = { readonly kind: 'too-long'; readonly words: number; readonly limit: number } | { readonly kind: 'view-too-large' } | { readonly kind: 'access-lost' } | { readonly kind: 'masking-cleared' } | { readonly kind: 'source-changed' };

/** What the panel keeps while it is closed: the thread of one investigation under one masking. `epoch` changes whenever the thread is cleared, so an answer that was sent before cannot come back. */
export interface AssistantSessionState {
  readonly investigationId: string | null;
  readonly principalId: string | null;
  readonly mask: boolean;
  readonly epoch: number;
  readonly input: string;
  readonly nextId: number;
  readonly turns: readonly Turn[];
  readonly notice: Notice | undefined;
}

const EMPTY_ASSISTANT_SESSION: AssistantSessionState = { investigationId: null, principalId: null, mask: false, epoch: 0, input: '', nextId: 1, turns: [], notice: undefined };

export interface AssistantSession {
  readonly store: Store<AssistantSessionState>;
  /** The requests that are out; ending them is how a clearing keeps their answers from coming back. */
  readonly open: Set<AbortController>;
  /** Clears the thread and every request that is out, and starts the next epoch. */
  clear(next: Partial<AssistantSessionState>): void;
}

export function createAssistantSession(): AssistantSession {
  const store = createStore<AssistantSessionState>(EMPTY_ASSISTANT_SESSION);
  const open = new Set<AbortController>();
  return {
    store,
    open,
    clear(next) {
      for (const controller of open) controller.abort();
      open.clear();
      const held = store.getState();
      store.setState({ ...EMPTY_ASSISTANT_SESSION, investigationId: held.investigationId, principalId: held.principalId, mask: held.mask, epoch: held.epoch + 1, ...next });
    },
  };
}

export const isAskAnswer = (answer: AskAnswer): answer is Extract<AskAnswer, { answered: unknown }> => 'answered' in answer;

const Context = createContext<AssistantSession | undefined>(undefined);

export const AssistantSessionProvider = Context.Provider;

export function useAssistantSession(): AssistantSession {
  const session = useContext(Context);
  if (session === undefined) throw new Error('the Assistant panel needs its session');
  return session;
}
