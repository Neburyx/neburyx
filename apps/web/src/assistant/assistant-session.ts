import type { TurnStep } from '../api/turn-stream.js';
import { createContext, useContext } from 'react';
import type { AssistantChoice, AssistantFailureKind, AssistantLimit, AssistantRead, AssistantRefusalCause, AssistantTurnAnswer, AskAnswer } from '@neburyx/contracts';
import type { CitationEntry } from '../summary/summary-model.js';
import type { ApiFailure } from '../api/client.js';
import type { AddedOutcome } from '../patterns/add-to-graph.js';
import type { Answered, Refused } from '../ask/ask-session.js';
import { createStore, type Store } from '../state/store.js';
import { NO_STORED_THREAD, type StoredThreadState } from './stored-thread-state.js';

export interface FollowUp {
  readonly titles: readonly string[];
  readonly choice: AssistantChoice;
}

export interface ClarificationCandidate {
  readonly title: string;
  readonly type: string;
  readonly choice: AssistantChoice;
}

/** What a heavy step of the loop waits for: the pending id and the plan the decision sends back, what the step would read, the reads so far, and the message and the keys of the view of the turn, which the decision sends again as they were. */
export interface Waiting {
  readonly pendingId: string;
  readonly plan: string;
  readonly step: Extract<AssistantTurnAnswer, { status: 'confirmation' }>['step'];
  readonly reads: readonly AssistantRead[];
  readonly message: string;
  readonly viewElementKeys: readonly string[];
}

export type Retry =
  | { readonly kind: 'decision'; readonly waiting: Waiting; readonly decision: 'confirm' | 'skip' }
  | { readonly kind: 'message'; readonly text: string }
  | { readonly kind: 'chip'; readonly followUp: FollowUp }
  | { readonly kind: 'choice'; readonly question: string; readonly candidates: readonly ClarificationCandidate[]; readonly index: number }
  | { readonly kind: 'continue'; readonly intent: string; readonly entities: Answered['entities']; readonly token: string; readonly heavy: Answered };

export type Failure =
  | { readonly kind: 'unavailable'; readonly why: AssistantFailureKind; readonly readStarted: boolean; readonly retryAfterSeconds: number | undefined; readonly until: number | undefined }
  | { readonly kind: 'too-large'; readonly sentence: string }
  | { readonly kind: 'confirmation-invalid'; readonly sentence: string }
  | { readonly kind: 'request'; readonly failure: ApiFailure; readonly until: number | undefined }
  | { readonly kind: 'continue-invalid' }
  | { readonly kind: 'choice-invalid' }
  | { readonly kind: 'follow-up-invalid' }
  | { readonly kind: 'summary-invalid'; readonly sentence: string };

/** An answer of sentences that cite elements: from the view, or after tool steps (then it carries the number of steps). */
export type SentencesAnswer = Extract<AssistantTurnAnswer, { status: 'answered'; sentences: unknown }>;

/** An answer written as a table whose every row cites elements: from the view, or after tool steps. */
export type TableAnswer = Extract<AssistantTurnAnswer, { status: 'answered'; table: unknown }>;

export type ViewAnswer = SentencesAnswer | TableAnswer;

export type Outcome =
  | { readonly kind: 'pending'; readonly call: 'message'; readonly steps?: readonly TurnStep[] }
  | { readonly kind: 'pending'; readonly call: 'continue'; readonly heavy: Answered; readonly token: string; readonly steps?: readonly TurnStep[] }
  | { readonly kind: 'pending'; readonly call: 'choice'; readonly question: string; readonly candidates: readonly ClarificationCandidate[]; readonly steps?: readonly TurnStep[] }
  | { readonly kind: 'pending'; readonly call: 'decide'; readonly waiting: Waiting; readonly decision: 'confirm' | 'skip'; readonly steps?: readonly TurnStep[] }
  | { readonly kind: 'waiting'; readonly waiting: Waiting }
  /** A confirmation that is no longer open (another message was sent, or the panel was reloaded): the reads stay, the buttons are gone. */
  | { readonly kind: 'waiting-closed'; readonly reads: readonly AssistantRead[] }
  | { readonly kind: 'cancelled' }
  /** A refusal of the assistant; a verdict may carry a neutral overview of the view, beside the fixed sentence, with the entries of what it cites. */
  | { readonly kind: 'refuse'; readonly cause: AssistantRefusalCause; readonly sentence: string; readonly overview?: ViewAnswer; readonly entries?: readonly CitationEntry[] }
  | { readonly kind: 'not-answered'; readonly sentence: string }
  /** The question was about types the mapping does not describe: the fixed sentence of the server. */
  | { readonly kind: 'no-description'; readonly sentence: string }
  /** The answer to what types mean, written by the server from the operator's text: no model wrote it. */
  | { readonly kind: 'meaning'; readonly described: readonly { readonly typeKind: 'entity' | 'relationship'; readonly type: string; readonly description: string }[]; readonly sentence: string | undefined }
  | { readonly kind: 'limit'; readonly limit: AssistantLimit; readonly sentence: string; readonly reads: readonly AssistantRead[] }
  | { readonly kind: 'answered'; readonly answer: Answered; readonly added: AddedOutcome | undefined; readonly reads: readonly AssistantRead[] | undefined; readonly stoppedAt: AssistantLimit | undefined; readonly coverage: string | undefined; readonly followUps: readonly FollowUp[] }
  | { readonly kind: 'view-answer'; readonly answer: ViewAnswer; readonly entries: readonly CitationEntry[] }
  | { readonly kind: 'clarification'; readonly question: string; readonly candidates: readonly ClarificationCandidate[]; readonly failed?: { readonly failure: Failure; readonly index: number } }
  | { readonly kind: 'ask-refused'; readonly refused: Refused }
  | { readonly kind: 'heavy'; readonly answer: Answered; readonly token: string }
  | { readonly kind: 'failed'; readonly failure: Failure; readonly retry: Retry };

export interface Turn {
  readonly id: number;
  readonly message: string;
  readonly outcome: Outcome;
  /** The turn was started by pressing a follow-up, so its message is the follow-up's label and is not the analyst's to type again. */
  readonly chip?: true;
}

type Notice = { readonly kind: 'too-long'; readonly words: number; readonly limit: number } | { readonly kind: 'view-too-large' } | { readonly kind: 'access-lost' } | { readonly kind: 'masking-cleared'; readonly summary?: true } | { readonly kind: 'source-changed' };

/** An AI case summary the person handed to the thread: what the thread shows of it, and the token that goes with each message while it is attached. It leaves with the thread. */
export interface AttachedSummary {
  readonly token: string;
  readonly sentences: readonly string[];
  readonly model: string;
  /** When the draft arrived, in milliseconds. */
  readonly arrivedAt: number;
  /** Whether the token goes with the next message; a removed or refused summary stays shown. */
  readonly status: 'attached' | 'removed' | 'invalid';
}

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
  readonly summary: AttachedSummary | undefined;
}

const EMPTY_ASSISTANT_SESSION: AssistantSessionState = { investigationId: null, principalId: null, mask: false, epoch: 0, input: '', nextId: 1, turns: [], notice: undefined, summary: undefined };

export interface AssistantSession {
  readonly store: Store<AssistantSessionState>;
  /** What the server kept of this person's thread of the investigation, read once for each epoch; cleared with the thread. */
  readonly stored: Store<StoredThreadState>;
  /** The requests that are out; ending them is how a clearing keeps their answers from coming back. */
  readonly open: Set<AbortController>;
  /** Clears the thread and every request that is out, and starts the next epoch. */
  clear(next: Partial<AssistantSessionState>): void;
}

export function createAssistantSession(): AssistantSession {
  const store = createStore<AssistantSessionState>(EMPTY_ASSISTANT_SESSION);
  const stored = createStore<StoredThreadState>(NO_STORED_THREAD);
  const open = new Set<AbortController>();
  return {
    store,
    stored,
    open,
    clear(next) {
      for (const controller of open) controller.abort();
      open.clear();
      stored.setState(NO_STORED_THREAD);
      const held = store.getState();
      store.setState({ ...EMPTY_ASSISTANT_SESSION, investigationId: held.investigationId, principalId: held.principalId, mask: held.mask, epoch: held.epoch + 1, ...next });
    },
  };
}

export const isAskAnswer = (answer: AskAnswer): answer is Extract<AskAnswer, { answered: unknown }> => 'answered' in answer;

const sessions = new WeakMap<object, AssistantSession>();

/** The session of the Assistant panel bound to a client state, for the parts of the page outside the panel that hand it something (the summary panel). */
export const registerAssistantSession = (owner: object, session: AssistantSession): (() => void) => {
  sessions.set(owner, session);
  return () => {
    if (sessions.get(owner) === session) sessions.delete(owner);
  };
};

export const assistantSessionOf = (owner: object): AssistantSession | undefined => sessions.get(owner);

const Context = createContext<AssistantSession | undefined>(undefined);

export const AssistantSessionProvider = Context.Provider;

export function useAssistantSession(): AssistantSession {
  const session = useContext(Context);
  if (session === undefined) throw new Error('the Assistant panel needs its session');
  return session;
}
