import { browserClearNotice, type ClearNotice } from './clear-notice.js';
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

/** An answer of blocks (sentences and tables) whose every sentence and row cites elements: from the view, or after tool steps. */
export type ViewAnswer = Extract<AssistantTurnAnswer, { status: 'answered'; blocks: unknown }>;

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
  | { readonly kind: 'view-answer'; readonly answer: ViewAnswer; readonly entries: readonly CitationEntry[]; /** The follow-ups of an answer of the ask route that rests on a read of one of the folder's questions, as under Ask's own answer. */ readonly followUps?: readonly FollowUp[] }
  | { readonly kind: 'clarification'; readonly question: string; readonly candidates: readonly ClarificationCandidate[]; readonly failed?: { readonly failure: Failure; readonly index: number } }
  /** A refusal of Ask inside a turn; the reads the earlier steps of a tool loop made, when the refusal ended the loop. */
  | { readonly kind: 'ask-refused'; readonly refused: Refused; readonly reads?: readonly AssistantRead[] | undefined }
  | { readonly kind: 'heavy'; readonly answer: Answered; readonly token: string }
  | { readonly kind: 'failed'; readonly failure: Failure; readonly retry: Retry };

export interface Turn {
  readonly id: number;
  /** The ids of the requests this turn sent (its message, then a choice, a continue or a decision), each the id the server gives the turn it writes for it, so that the thread read can tell these turns from the earlier ones. */
  readonly turnIds?: readonly string[];
  /** The count the server told for this turn when its response began (the header), so a turn that began before a clearing can be told from one that began after; absent until it arrives, and for a server that sends none. */
  readonly threadEpoch?: number;
  /** The turn was kept through a reconciliation while the server had told no count for it: its answer is not shown unless the count arrives. */
  readonly unverified?: true;
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
  /** Counts the notices of a clearing this session has heard: a stored read that began before the last one is from before it and is not shown. */
  readonly invalidated: { token: number };
  /** Rises when a notice asks for the stored thread to be read again while it is shown; `pending` says the asking was not served yet (the panel may be closed). */
  readonly refresh: Store<number>;
  readonly refreshing: { pending: boolean };
  /** The request of each pending turn by its number, so a turn that is dropped can be ended. */
  readonly requests: Map<number, AbortController>;
  /** `epoch` is the count of the last thread read taken, which the stored turns shown belong to; `seen` is the highest count heard from a read or a turn's header. A read or a turn with a count below `seen` is from before and is not shown. Both belong to one person and one investigation. */
  readonly known: { epoch: number | undefined; seen: number | undefined };
  /** Clears the thread and every request that is out, and starts the next epoch. */
  clear(next: Partial<AssistantSessionState>): void;
  /** Tells the other sessions of this person in the browser that a chat was cleared, and hears them; absent where the browser has no channel. */
  readonly notice?: ClearNotice | undefined;
}

/** `notice` is the channel to the other windows: the browser's by default, none for `null` (a test that has no other window). */
export function createAssistantSession(notice: ClearNotice | null | undefined = browserClearNotice()): AssistantSession {
  const store = createStore<AssistantSessionState>(EMPTY_ASSISTANT_SESSION);
  const stored = createStore<StoredThreadState>(NO_STORED_THREAD);
  const open = new Set<AbortController>();
  const requests = new Map<number, AbortController>();
  const invalidated = { token: 0 };
  const refresh = createStore(0);
  const refreshing = { pending: false };
  const known: { epoch: number | undefined; seen: number | undefined } = { epoch: undefined, seen: undefined };
  return {
    store,
    stored,
    open,
    requests,
    known,
    invalidated,
    refresh,
    refreshing,
    notice: notice ?? undefined,
    clear(next) {
      for (const controller of open) controller.abort();
      open.clear();
      requests.clear();
      stored.setState(NO_STORED_THREAD);
      const held = store.getState();
      const otherScope = (next.investigationId !== undefined && next.investigationId !== held.investigationId) || (next.principalId !== undefined && next.principalId !== held.principalId);
      if (otherScope) {
        known.epoch = undefined;
        known.seen = undefined;
      }
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
