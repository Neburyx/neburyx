import { createContext, useContext } from 'react';
import type { ApiFailure } from '../api/client.js';
import { createStore, type Store } from '../state/store.js';
import type { CitationEntry, DraftResponse, SummaryOutcome } from './summary-model.js';

/** A draft the panel holds: the answer, the citation numbers and labels fixed when it arrived, and the edits of the person, which live nowhere else. */
export interface SummaryDraft {
  readonly response: DraftResponse;
  readonly entries: readonly CitationEntry[];
  /** The edited text of a sentence, by its position in the response. */
  readonly edits: ReadonlyMap<number, string>;
  /** The scope line of the view as it was when the draft arrived. */
  readonly viewLine: string;
}

/** What Copy to notes has come to for the draft on screen. */
export type CopyStage =
  | { readonly kind: 'idle' }
  | { readonly kind: 'copying' }
  | { readonly kind: 'copied'; readonly copied: number; readonly notCopied: number; readonly alreadyCopied: boolean }
  | { readonly kind: 'refused' }
  | { readonly kind: 'full' }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'failed'; readonly failure: ApiFailure | undefined };

type SummaryAttempt = { readonly kind: 'idle' } | { readonly kind: 'generating' } | { readonly kind: 'outcome'; readonly outcome: SummaryOutcome };

/** What the panel keeps while it is closed, for one investigation and one masking: the draft on screen and the outcome of the latest attempt, which may sit beside an earlier draft. */
export interface SummarySessionState {
  readonly investigationId: string | null;
  readonly mask: boolean;
  readonly draft: SummaryDraft | undefined;
  readonly attempt: SummaryAttempt;
  readonly copy: CopyStage;
  /** How many copies stored something, so a part of the panel that shows the notes knows to read them again. */
  readonly copies: number;
}

export const EMPTY_SUMMARY_SESSION: SummarySessionState = { investigationId: null, mask: false, draft: undefined, attempt: { kind: 'idle' }, copy: { kind: 'idle' }, copies: 0 };

export type SummarySession = Store<SummarySessionState>;

export const createSummarySession = (): SummarySession => createStore<SummarySessionState>(EMPTY_SUMMARY_SESSION);

const SummarySessionContext = createContext<SummarySession | undefined>(undefined);

export const SummarySessionProvider = SummarySessionContext.Provider;

export function useSummarySession(): SummarySession {
  const session = useContext(SummarySessionContext);
  if (session === undefined) throw new Error('the summary panel needs its session');
  return session;
}
