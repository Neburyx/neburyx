import { ASK_REFUSAL_SENTENCES } from '@neburyx/contracts';
import type { ApiFailure } from '../api/client.js';
import { failureWords, type FailureWords } from '../patterns/failure-words.js';
import { ASK_COPY, limitHopsText, limitPathsText } from './copy.js';

const UNAVAILABLE = 'Ask is not available right now.';

const reasonOf = (failure: ApiFailure): unknown => ('details' in failure && failure.details !== undefined ? Object.getOwnPropertyDescriptor(failure.details, 'reason')?.value : undefined);

const numberDetail = (failure: ApiFailure, name: string): number | undefined => {
  const value: unknown = 'details' in failure && failure.details !== undefined ? Object.getOwnPropertyDescriptor(failure.details, name)?.value : undefined;
  return typeof value === 'number' ? value : undefined;
};

const FILE_QUERY_WORDS: Readonly<Record<string, string>> = {
  'file-query-text': 'The query behind this question is not allowed to run.',
  'file-query-intent': 'This question has no query for this source.',
  'file-query-values': 'The values of this question do not fit its query.',
  'file-query-result': 'The query behind this question returned something that cannot be drawn on the graph.',
};

/** A failure that is the answer to a build without Ask: it is drawn as the card of the cause `unavailable`, with the server's fixed sentence. */
export const isNotInThisEdition = (failure: ApiFailure): boolean => failure.code === 'ASK_UNSUPPORTED' && reasonOf(failure) === 'not-in-this-edition';

const unavailableSentence = ASK_REFUSAL_SENTENCES.unavailable;

/** A failure that says a Continue is no longer valid: the token expired, was altered or is not this person's. */
export const isContinueInvalid = (failure: ApiFailure): boolean => failure.code === 'INVALID_REQUEST' && reasonOf(failure) === 'continue-invalid';

/** A failure of an Ask call in words: the product's own failure words, with the ones about Ask not being there put as one sentence that offers no retry, and the failures only Ask has in its own words. */
export function askFailureWords(failure: ApiFailure, source: string): FailureWords {
  if (failure.code === 'ASK_UNSUPPORTED' || (failure.code === 'ACCESS_DENIED' && reasonOf(failure) === 'ai-off')) return { text: UNAVAILABLE };
  if (isContinueInvalid(failure)) return { text: ASK_COPY.continueInvalid };
  if (failure.code === 'INVALID_REQUEST') {
    const reason = reasonOf(failure);
    const words = typeof reason === 'string' ? FILE_QUERY_WORDS[reason] : undefined;
    if (words !== undefined) return { text: words };
  }
  if (failure.code === 'ASK_INTENT_INVALID' || failure.code === 'SOURCE_MISMATCH') return { text: 'The values of this question do not fit what it asks for. Ask it again.' };
  // the record of the run could not be kept, so the answer is withheld; the question may have run
  if (failure.code === 'AUDIT_UNAVAILABLE') return { text: 'The record of this could not be kept, so the answer is withheld. The question may have run. Try again later.', action: 'try-again' };
  if (failure.code === 'QUERY_BUDGET_EXCEEDED') {
    // the figure the refusal carries says which limit it is: only a path run carries `pathResultsCap`, and a result size (`maxPage`) keeps the shared words
    const cap = numberDetail(failure, 'pathResultsCap');
    if (cap !== undefined) return { text: limitPathsText(cap) };
    const hops = numberDetail(failure, 'maxHops');
    if (hops !== undefined) return { text: limitHopsText(hops) };
  }
  return failureWords(failure, source);
}
