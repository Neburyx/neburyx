import { describe, expect, it } from 'vitest';
import type { ApiFailure } from '../api/client.js';
import { FAILURE_CODES_WITH_WORDS } from '../patterns/failure-words.js';
import { PLAN_FAILURE_COPY, planFailureWords, type PlanCall } from './plan-failure.js';

const server = (code: string, details?: Record<string, unknown>): ApiFailure => ({ code, message: 'm', retryable: false, traceId: 'tr-SECRET-1', ...(details === undefined ? {} : { details }) }) as ApiFailure;
const client = (code: string): ApiFailure => ({ code }) as ApiFailure;
const CALLS: readonly PlanCall[] = ['run', 'continue', 'edit', 'cancel'];

describe('a plan that is gone or past its time', () => {
  it.each(CALLS)('says to ask again for a plan that is not found, on a %s', (call) => {
    expect(planFailureWords(server('NOT_FOUND'), 'demo', call)).toEqual({ text: PLAN_FAILURE_COPY.gone, action: 'ask-again' });
  });
});

describe('an answer that was lost', () => {
  it.each(['NETWORK_UNAVAILABLE', 'UNREADABLE_RESPONSE', 'INTERNAL_ERROR', 'UNEXPECTED_FAILURE', 'SCHEMA_MISMATCH'])('says a run may have run, and offers only asking again, for %s', (code) => {
    for (const call of ['run', 'continue'] as const) expect(planFailureWords(server(code), 'demo', call)).toEqual({ text: PLAN_FAILURE_COPY.mayHaveRun, action: 'ask-again' });
  });

  it('lets an edit or a cancel that was lost be tried again', () => {
    expect(planFailureWords(client('NETWORK_UNAVAILABLE'), 'demo', 'edit')).toEqual({ text: PLAN_FAILURE_COPY.notSaved, action: 'try-again' });
    expect(planFailureWords(client('NETWORK_UNAVAILABLE'), 'demo', 'cancel')).toEqual({ text: PLAN_FAILURE_COPY.notCancelled, action: 'try-again' });
  });
});

describe('values and tokens that are refused', () => {
  it('says the values do not fit, keeps the fields and offers nothing, for ASK_PLAN_INVALID and SOURCE_MISMATCH and for an invalid edit', () => {
    for (const failure of [server('ASK_PLAN_INVALID'), server('SOURCE_MISMATCH')]) expect(planFailureWords(failure, 'demo', 'edit')).toEqual({ text: PLAN_FAILURE_COPY.invalidValues, action: 'none' });
    expect(planFailureWords(server('INVALID_REQUEST'), 'demo', 'edit')).toEqual({ text: PLAN_FAILURE_COPY.invalidValues, action: 'none' });
  });

  it('says to run the plan again, which is still proposed, for a continue the server did not accept', () => {
    expect(planFailureWords(server('INVALID_REQUEST'), 'demo', 'continue')).toEqual({ text: PLAN_FAILURE_COPY.badContinue, action: 'run-again' });
  });

  it('says a plan that ran but could not be recorded is spent, for a run and a continue', () => {
    for (const call of ['run', 'continue'] as const) expect(planFailureWords(server('AUDIT_UNAVAILABLE'), 'demo', call)).toEqual({ text: PLAN_FAILURE_COPY.notRecorded, action: 'ask-again' });
  });
});

describe('a refusal of Ask or of the read', () => {
  it('uses the sentence of Ask for the two refusals that say Ask is not available, with nothing to do', () => {
    for (const call of CALLS) {
      expect(planFailureWords(server('ASK_UNSUPPORTED', { reason: 'not-in-this-edition' }), 'demo', call)).toEqual({ text: 'Ask is not available right now.', action: 'none' });
      expect(planFailureWords(server('ACCESS_DENIED', { reason: 'ai-preview-off' }), 'demo', call)).toEqual({ text: 'Ask is not available right now.', action: 'none' });
    }
  });

  it('says to ask again, never to run the same plan again, for a read the gate refused after the claim', () => {
    for (const code of ['SOURCE_UNAVAILABLE', 'SOURCE_BUSY', 'QUERY_TIMEOUT']) expect(planFailureWords(server(code, { timeoutMs: 20000 }), 'demo', 'run').action).toBe('ask-again');
    expect(planFailureWords(server('RATE_LIMITED', { retryAfterMs: 3000 }), 'demo', 'continue')).toMatchObject({ action: 'ask-again', waitMs: 3000 });
  });

  it('gives no action for a budget that is over, which asking the same again cannot change', () => {
    expect(planFailureWords(server('QUERY_BUDGET_EXCEEDED', { maxPage: 50 }), 'demo', 'run')).toEqual({ text: 'The source allows at most 50 results at a time.', action: 'none' });
  });
});

describe('the words of every code, for every call', () => {
  it.each(FAILURE_CODES_WITH_WORDS)('give one sentence for %s with no ID, code or trace in it', (code) => {
    for (const call of CALLS) {
      const words = planFailureWords(server(code, { reason: 'source-changed', retryAfterMs: 2000, timeoutMs: 1000, maxPage: 5 }), 'demo', call);
      expect(words.text.length).toBeGreaterThan(5);
      expect(words.text).not.toMatch(/tr-SECRET|source-changed|[A-Z]{2,}_[A-Z_]+|[0-9a-f]{8}-[0-9a-f]{4}/);
    }
  });
});
