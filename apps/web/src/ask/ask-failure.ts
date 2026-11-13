import type { ApiFailure } from '../api/client.js';
import { failureWords, type FailureWords } from '../patterns/failure-words.js';
import { ASK_COPY } from './copy.js';

const reasonOf = (failure: ApiFailure): unknown => ('details' in failure && failure.details !== undefined ? Object.getOwnPropertyDescriptor(failure.details, 'reason')?.value : undefined);

/** A failure of an Ask call in words: the product's own failure words, with the ones about Ask not being there put as one sentence that offers no retry. */
export function askFailureWords(failure: ApiFailure, source: string): FailureWords {
  if (failure.code === 'ASK_UNSUPPORTED' || (failure.code === 'ACCESS_DENIED' && reasonOf(failure) === 'ai-preview-off')) return { text: ASK_COPY.unavailable };
  return failureWords(failure, source);
}

export const isPicksRefusal = (failure: ApiFailure): boolean => failure.code === 'INVALID_REQUEST';
