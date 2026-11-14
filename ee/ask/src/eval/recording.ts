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
export function recordingProvider(inner: ModelProvider, budget: number): Recording {
  const answers = new Map<string, ReplayAnswer>();
  const total = { calls: 0, failed: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, withoutCounts: 0 };
  return {
    answers: () => answers,
    usage: () => ({ ...total }),
    provider: {
      async complete(request: ModelRequest, signal: AbortSignal): Promise<ModelAnswer> {
        if (total.calls >= budget) throw new BudgetReached('the budget is reached');
        total.calls += 1;
        let answer: ModelAnswer;
        try {
          answer = await inner.complete(request, signal);
        } catch (error) {
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
