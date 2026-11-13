import { PATTERN_LIMITS, type ErrorCode } from '@neburyx/contracts';
import type { ApiFailure, ClientFailure } from '../api/client.js';
import { busyHeadline, timedOutHeadline, unavailableHeadline } from '../banner/copy.js';

/** Every way a call can fail: the server's codes and the client's own. */
export type FailureCode = ErrorCode | ClientFailure['code'];

/** What the person can do about a failure: try the same thing again, or only close what is shown; nothing when the sentence says it all. */
export type FailureAction = 'try-again' | 'close';

export interface FailureWords {
  /** One sentence, with no code, no query text and no value from the source. */
  readonly text: string;
  readonly action?: FailureAction;
  /** For a rate limit: how long the server asks the person to wait, in milliseconds; the sentence and the action count it. */
  readonly waitMs?: number;
}

export const TRY_AGAIN = 'Try again';
export const tryAgainIn = (seconds: number): string => (seconds > 0 ? `Try again in ${seconds} s` : TRY_AGAIN);
/** The sentence of a rate limit that names the wait, or says the wait is over. */
export const rateLimitedSentence = (seconds: number): string => (seconds > 0 ? `You can try again in ${seconds} s.` : 'You can try again now.');

const detailOf = (failure: ApiFailure, key: string): unknown => ('details' in failure && failure.details !== undefined ? Object.getOwnPropertyDescriptor(failure.details, key)?.value : undefined);
const numberDetail = (failure: ApiFailure, key: string): number | undefined => {
  const value = detailOf(failure, key);
  return typeof value === 'number' ? value : undefined;
};

export const retryAfterMsOf = (failure: ApiFailure): number | undefined => numberDetail(failure, 'retryAfterMs');
export const timeoutMsOf = (failure: ApiFailure): number | undefined => numberDetail(failure, 'timeoutMs');
export const maxHopsOf = (failure: ApiFailure): number | undefined => numberDetail(failure, 'maxHops');
export const maxPageOf = (failure: ApiFailure): number | undefined => numberDetail(failure, 'maxPage');
const reasonOf = (failure: ApiFailure): string | undefined => {
  const reason = detailOf(failure, 'reason');
  return typeof reason === 'string' ? reason : undefined;
};

export const patternLimitSentence = `This source already holds ${PATTERN_LIMITS.patternsPerSource} saved patterns. Delete one first.`;
export const personalConditionSentence = 'A condition of this pattern uses a property the mapping marks as personal data, so it cannot be saved, shared or copied.';

type Entry = (failure: ApiFailure, source: string) => FailureWords;
const said = (text: string, action?: FailureAction): Entry => () => ({ text, ...(action === undefined ? {} : { action }) });

/** A failure of a pattern call in words, one entry for each code (a missing one does not compile): what happened, and what the person can do. */
const TABLE: { readonly [C in FailureCode]: Entry } = {
  QUERY_BUDGET_EXCEEDED: (failure) => {
    const hops = maxHopsOf(failure);
    const page = maxPageOf(failure);
    if (hops !== undefined) return { text: `The source allows at most ${hops} steps.`, action: 'close' };
    if (page !== undefined) return { text: `The source allows at most ${page} results at a time.`, action: 'close' };
    return { text: 'This asks for more than the source allows. Ask for less.', action: 'close' };
  },
  QUERY_TIMEOUT: (failure, source) => {
    const limit = timeoutMsOf(failure);
    return { text: limit === undefined ? `${source} did not answer in time.` : timedOutHeadline(source, limit), action: 'try-again' };
  },
  SOURCE_UNAVAILABLE: (_failure, source) => ({ text: unavailableHeadline(source), action: 'try-again' }),
  SOURCE_BUSY: (_failure, source) => ({ text: busyHeadline(source), action: 'try-again' }),
  RATE_LIMITED: (failure) => {
    const wait = retryAfterMsOf(failure);
    return { text: wait === undefined ? 'Too many requests. Try again in a moment.' : rateLimitedSentence(Math.ceil(wait / 1000)), action: 'try-again', ...(wait === undefined ? {} : { waitMs: wait }) };
  },
  ACCESS_DENIED: said('You may not do this on this source.', 'close'),
  CURSOR_INVALIDATED: said('This list is out of date. Start it again.', 'close'),
  PARTIAL_RESULT: said('Only part of the answer could be read, so it is not complete.', 'close'),
  EVIDENCE_NOT_AVAILABLE: said('The evidence for this is not available.', 'close'),
  CONFLICTED_VIEW_VERSION: said('This view was changed elsewhere. Reload it, then try again.', 'close'),
  CONFLICT: said('This was changed elsewhere. Reload it, then try again.', 'close'),
  EXPORT_FAILED: said('The export could not be made.', 'try-again'),
  ASK_UNSUPPORTED: said('This question cannot be answered here.', 'close'),
  ASK_PLAN_INVALID: said('The plan for this question was not accepted.', 'close'),
  INVALID_REQUEST: (failure) => {
    const reason = reasonOf(failure);
    if (reason === 'pattern-limit') return { text: patternLimitSentence, action: 'close' };
    if (reason === 'pattern-personal-condition') return { text: personalConditionSentence, action: 'close' };
    return { text: 'The server did not accept this request.', action: 'close' };
  },
  UNSUPPORTED_MEDIA_TYPE: said('The server could not read this request.', 'close'),
  NOT_FOUND: said('This was not found. It may have been removed.', 'close'),
  INTERNAL_ERROR: said('Something went wrong on the server. Try again; if it keeps happening, tell an administrator.', 'try-again'),
  SOURCE_MISMATCH: said('The answer belongs to another source, so it was not used.', 'close'),
  AUDIT_UNAVAILABLE: said('The record of this could not be kept, so nothing was done. Try again later.', 'try-again'),
  NETWORK_UNAVAILABLE: said('The server could not be reached.', 'try-again'),
  UNREADABLE_RESPONSE: said('The answer could not be read.', 'try-again'),
  SCHEMA_MISMATCH: said('The answer was not in the form expected.', 'close'),
  ABORTED: said('The request was cancelled.'),
  UNEXPECTED_FAILURE: said('Something went wrong.', 'try-again'),
};

/** A failure in words. `source` is the name of the source the person works on, which the four sentences about a source state use. */
export const failureWords = (failure: ApiFailure, source: string): FailureWords => TABLE[failure.code](failure, source);

/** Every code the table has an entry for, so that a test can check it against the contract's list. */
export const FAILURE_CODES_WITH_WORDS = Object.keys(TABLE) as readonly FailureCode[];
