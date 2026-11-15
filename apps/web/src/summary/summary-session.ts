import { createContext, useContext } from 'react';
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

type SummaryAttempt = { readonly kind: 'idle' } | { readonly kind: 'generating' } | { readonly kind: 'outcome'; readonly outcome: SummaryOutcome };

/** What the panel keeps while it is closed, for one investigation and one masking: the draft on screen and the outcome of the latest attempt, which may sit beside an earlier draft. */
export interface SummarySessionState {
  readonly investigationId: string | null;
  readonly mask: boolean;
  readonly draft: SummaryDraft | undefined;
  readonly attempt: SummaryAttempt;
}

export const EMPTY_SUMMARY_SESSION: SummarySessionState = { investigationId: null, mask: false, draft: undefined, attempt: { kind: 'idle' } };

export type SummarySession = Store<SummarySessionState>;

export const createSummarySession = (): SummarySession => createStore<SummarySessionState>(EMPTY_SUMMARY_SESSION);

const SummarySessionContext = createContext<SummarySession | undefined>(undefined);

export const SummarySessionProvider = SummarySessionContext.Provider;

export function useSummarySession(): SummarySession {
  const session = useContext(SummarySessionContext);
  if (session === undefined) throw new Error('the summary panel needs its session');
  return session;
}
