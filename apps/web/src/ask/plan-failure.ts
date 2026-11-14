import type { ApiFailure } from '../api/client.js';
import { failureWords } from '../patterns/failure-words.js';
import { askFailureWords } from './ask-failure.js';

/** What the person can do after a plan call failed: ask the question again (the plan cannot be used any more), press Run again (the plan is still proposed), try the same save or cancel again, or nothing. */
type PlanAction = 'ask-again' | 'run-again' | 'try-again' | 'none';

export interface PlanFailureWords {
  readonly text: string;
  readonly action: PlanAction;
  /** For a rate limit: the wait the server asks for, in milliseconds. */
  readonly waitMs?: number;
}

export type PlanCall = 'run' | 'continue' | 'edit' | 'cancel';

const detailOf = (failure: ApiFailure, key: string): unknown => ('details' in failure && failure.details !== undefined ? Object.getOwnPropertyDescriptor(failure.details, key)?.value : undefined);

export const PLAN_FAILURE_COPY = {
  gone: 'This plan is no longer there. Ask the question again.',
  invalidValues: "These values don't fit this plan. Check them and save again.",
  badContinue: 'That continue is no longer valid. Run the plan again to get a new one.',
  notRecorded: "The plan ran but could not be recorded, so its result is not shown and it cannot run again. Ask the question again.",
  mayHaveRun: 'The plan may have run, and its result cannot be shown again. Ask the question again.',
  notSaved: 'The change may not have been saved. Try again.',
  notCancelled: 'The plan may not have been cancelled. Try again.',
  planOrPatternGone: 'This plan or its saved pattern is no longer available to you. Ask the question again.',
  patternChanged: 'The saved pattern changed after the plan was made, so it did not run. Ask the question again.',
  patternGone: 'The saved pattern is no longer available to you, so it did not run. Ask the question again.',
} as const;

/**
 * A failure of a call on a plan in words. The call matters because a run claims its plan before it reads: a failure after that leaves a plan that cannot run again (ask again), and a failure that is
 * only a lost answer says the plan may have run. Gate refusals use the product's own sentences; the sentences about Ask not being there are Ask's own. No sentence holds a code, an ID or a value.
 */
export function planFailureWords(failure: ApiFailure, source: string, call: PlanCall, savedPattern = false): PlanFailureWords {
  const { code } = failure;
  const reason = detailOf(failure, 'reason');
  if (code === 'CONFLICT' && reason === 'pattern-changed') return { text: PLAN_FAILURE_COPY.patternChanged, action: 'ask-again' };
  if (code === 'CONFLICT' && reason === 'pattern-unavailable') return { text: PLAN_FAILURE_COPY.patternGone, action: 'ask-again' };
  if (code === 'NOT_FOUND') return { text: savedPattern ? PLAN_FAILURE_COPY.planOrPatternGone : PLAN_FAILURE_COPY.gone, action: 'ask-again' };
  if (code === 'ASK_PLAN_INVALID' || code === 'SOURCE_MISMATCH') return { text: PLAN_FAILURE_COPY.invalidValues, action: 'none' };
  if (code === 'INVALID_REQUEST') return call === 'continue' ? { text: PLAN_FAILURE_COPY.badContinue, action: 'run-again' } : call === 'edit' ? { text: PLAN_FAILURE_COPY.invalidValues, action: 'none' } : { text: failureWords(failure, source).text, action: 'none' };
  if (code === 'AUDIT_UNAVAILABLE' && (call === 'run' || call === 'continue')) return { text: PLAN_FAILURE_COPY.notRecorded, action: 'ask-again' };
  if (code === 'ASK_UNSUPPORTED' || (code === 'ACCESS_DENIED' && reason === 'ai-preview-off')) return { text: askFailureWords(failure, source).text, action: 'none' };
  const lostAnswer = code === 'NETWORK_UNAVAILABLE' || code === 'UNREADABLE_RESPONSE' || code === 'INTERNAL_ERROR' || code === 'UNEXPECTED_FAILURE' || code === 'SCHEMA_MISMATCH';
  if (lostAnswer) {
    if (call === 'run' || call === 'continue') return { text: PLAN_FAILURE_COPY.mayHaveRun, action: 'ask-again' };
    return { text: call === 'edit' ? PLAN_FAILURE_COPY.notSaved : PLAN_FAILURE_COPY.notCancelled, action: 'try-again' };
  }
  const words = failureWords(failure, source);
  // a refusal of the read after the claim leaves a plan that is run: trying again means asking again
  const spent = call === 'run' || call === 'continue';
  const retryable = words.action === 'try-again';
  return { text: words.text, action: spent ? (retryable ? 'ask-again' : 'none') : retryable ? 'try-again' : 'none', ...(words.waitMs === undefined ? {} : { waitMs: words.waitMs }) };
}
