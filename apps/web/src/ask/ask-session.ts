import { createContext, useContext } from 'react';
import type { AskAnswer } from '@neburyx/contracts';
import type { ApiFailure } from '../api/client.js';
import type { AddedOutcome } from '../patterns/add-to-graph.js';
import { createStore, type Store } from '../state/store.js';

export type Answered = Extract<AskAnswer, { answered: unknown }>['answered'];
export type Refused = Extract<AskAnswer, { refused: unknown }>['refused'];

export type AskCall = 'ask' | 'continue';

export type AskStage =
  | { readonly kind: 'idle' }
  | { readonly kind: 'asking'; readonly call: AskCall }
  | { readonly kind: 'answered'; readonly answer: Answered; readonly seconds: number; readonly added: AddedOutcome | undefined }
  | { readonly kind: 'heavy'; readonly answer: Answered; readonly token: string; readonly seconds: number }
  | { readonly kind: 'refused'; readonly refused: Refused }
  | { readonly kind: 'failed'; readonly call: AskCall; readonly failure: ApiFailure; readonly heavy: { readonly answer: Answered; readonly token: string } | undefined }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'masking-cleared' };

/** What the panel keeps while it is closed: the question, the one that produced the stage, and the stage, for one investigation and one masking. */
export interface AskSessionState {
  readonly investigationId: string | null;
  readonly mask: boolean;
  readonly question: string;
  readonly asked: string;
  readonly stage: AskStage;
}

export const EMPTY_SESSION: AskSessionState = { investigationId: null, mask: false, question: '', asked: '', stage: { kind: 'idle' } };

export type AskSession = Store<AskSessionState>;

/** The session after a change of masking: an answer, a heavy-operation hold, or a question still asked is replaced by the note that masking cleared it. */
export function askSessionAfterMaskChange(held: AskSessionState, mask: boolean): AskSessionState {
  if (held.mask === mask) return held;
  const { stage } = held;
  const cleared = stage.kind === 'answered' || stage.kind === 'heavy' || stage.kind === 'asking' || (stage.kind === 'failed' && stage.heavy !== undefined);
  return { ...held, mask, stage: cleared ? { kind: 'masking-cleared' } : stage };
}

export const createAskSession = (): AskSession => createStore<AskSessionState>(EMPTY_SESSION);

const AskSessionContext = createContext<AskSession | undefined>(undefined);

export const AskSessionProvider = AskSessionContext.Provider;

export function useAskSession(): AskSession {
  const session = useContext(AskSessionContext);
  if (session === undefined) throw new Error('the Ask panel needs its session');
  return session;
}
