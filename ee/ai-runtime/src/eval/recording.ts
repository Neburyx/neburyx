import type { ModelAnswer, ModelProvider, ModelRequest } from '../provider.js';
import type { ReplayAnswer } from './replay.js';

/** Thrown by the provider of a recording run when a call would pass the budget. It is never made. */
export class BudgetReached extends Error {}

/** @public Named by the declared return type of the recording provider, which the entry script of the evaluation tool calls. */
export interface Usage {
  readonly calls: number;
  readonly failed: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  /** Calls whose answer did not state its token counts. */
  readonly withoutCounts: number;
  /** The median and the 95th percentile (nearest rank) of the time of a call in milliseconds, 0 when no call was made. */
  readonly medianMs: number;
  readonly p95Ms: number;
}

/** The value at the given share of the sorted times by nearest rank; 0 for none. */
export function percentileOf(times: readonly number[], share: number): number {
  if (times.length === 0) return 0;
  const sorted = [...times].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(share * sorted.length) - 1)] ?? 0;
}

/** @public Named by the declared return type of the recording provider, which the entry script of the evaluation tool calls. */
export interface Recording {
  readonly provider: ModelProvider;
  readonly answers: () => ReadonlyMap<string, ReplayAnswer>;
  readonly usage: () => Usage;
}

/**
 * Wraps a provider for a recording run: every call is counted before it is made and never passes the budget, and the answer to each question is kept in the form a replay reads.
 * The request is never kept beyond the question that is its key.
 */
export function recordingProvider(inner: ModelProvider, budget: number, now: () => number = Date.now): Recording {
  const answers = new Map<string, ReplayAnswer>();
  const total = { calls: 0, failed: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, withoutCounts: 0 };
  const times: number[] = [];
  return {
    answers: () => answers,
    usage: () => ({ ...total, medianMs: percentileOf(times, 0.5), p95Ms: percentileOf(times, 0.95) }),
    provider: {
      async complete(request: ModelRequest, signal: AbortSignal): Promise<ModelAnswer> {
        if (total.calls >= budget) throw new BudgetReached('the budget is reached');
        total.calls += 1;
        let answer: ModelAnswer;
        const started = now();
        try {
          answer = await inner.complete(request, signal);
          times.push(Math.max(0, now() - started));
        } catch (error) {
          times.push(Math.max(0, now() - started));
          total.failed += 1;
          total.withoutCounts += 1;
          answers.set(request.values, { failure: 'provider-error' });
          throw error;
        }
        if (answer.status === 'ok') answers.set(request.values, { reply: answer.text });
        else if (answer.status === 'refused') answers.set(request.values, { declined: true });
        else {
          total.failed += 1;
          answers.set(request.values, { failure: answer.code });
        }
        if (answer.usage?.kind === 'known') {
          total.inputTokens += answer.usage.inputTokens;
          total.outputTokens += answer.usage.outputTokens;
          total.cacheReadTokens += answer.usage.cacheReadTokens ?? 0;
          total.cacheWriteTokens += answer.usage.cacheWriteTokens ?? 0;
        } else total.withoutCounts += 1;
        return answer;
      },
    },
  };
}
