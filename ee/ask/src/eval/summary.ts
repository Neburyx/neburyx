import { createAuditedModelCall, percentileOf } from '@neburyx/ee-ai-runtime';
import { loadSummaryInstructions } from '../case-summary/load-instructions.js';
import { createMemorySummaryRunStore } from '../case-summary/run-store.js';
import { readSummarySettings, type SummarySettings } from '../case-summary/settings.js';
import { createCaseSummarizer, type ReplyObservation } from '../case-summary/summarizer.js';
import { promptRecordOf, type ModelAnswer, type ModelProvider, type ModelRequest } from '@neburyx/ee-ai-runtime';
import type { CaseSummaryOutcome, SummaryReading } from '@neburyx/contracts';

type Env = Readonly<Record<string, string | undefined>>;

/** @public Named by the declared types of the hooks that the entry script of the evaluation command calls. */
export type SummarySettingsRead = { readonly ok: true; readonly settings: SummarySettings } | { readonly ok: false; readonly problems: readonly string[] };

/** @public The settings of a summary run, read from the environment as the product reads them; a problem names the variable and never its value. */
export const summaryRunSettings = (env: Env): SummarySettingsRead => readSummarySettings(env);

/** @public A provider that answers each request with the reply a function gives for its values, holding no key and making no network call. */
export function scriptedSummaryProvider(replyFor: (values: string) => string): ModelProvider {
  return {
    async complete(request: ModelRequest): Promise<ModelAnswer> {
      return { status: 'ok', text: replyFor(request.values), usage: { kind: 'unknown' }, model: 'scripted', prompt: promptRecordOf(request) };
    },
  };
}

/** @public What a budgeted provider counts. */
export interface BudgetedUsage {
  /** Requests made to the inner provider. */
  readonly calls: number;
  /** Requests refused because they would have passed the budget: none was made. */
  readonly refused: number;
  readonly failed: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  /** Calls whose answer did not state its token counts. */
  readonly withoutCounts: number;
  /** The median and the 95th percentile of the time of a call in milliseconds, 0 when no call was made. */
  readonly medianMs: number;
  readonly p95Ms: number;
}

/** @public A provider whose requests all count against one budget. */
export interface BudgetedProvider {
  readonly provider: ModelProvider;
  readonly usage: () => BudgetedUsage;
}

/**
 * Wraps a provider so that its requests, of every kind, count against one budget: the nth request is made, and a request that would be the (n+1)th is not made and answers as a failed call. The wrapper retries nothing.
 * `onRequest` is told the values of each request that is made, for the run that holds it; nothing is kept.
 */
export function budgetedProvider(inner: ModelProvider, budget: number, onRequest?: (values: string) => void, now: () => number = Date.now): BudgetedProvider {
  const total = { calls: 0, refused: 0, failed: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, withoutCounts: 0 };
  const times: number[] = [];
  return {
    usage: () => ({ ...total, medianMs: percentileOf(times, 0.5), p95Ms: percentileOf(times, 0.95) }),
    provider: {
      async complete(request: ModelRequest, signal: AbortSignal): Promise<ModelAnswer> {
        if (total.calls >= budget) {
          total.refused += 1;
          return { status: 'failed', code: 'provider-error', usage: { kind: 'unknown' }, prompt: promptRecordOf(request) };
        }
        total.calls += 1;
        onRequest?.(request.values);
        let answer: ModelAnswer;
        const started = now();
        try {
          answer = await inner.complete(request, signal);
          times.push(Math.max(0, now() - started));
        } catch (error) {
          times.push(Math.max(0, now() - started));
          total.failed += 1;
          total.withoutCounts += 1;
          throw error;
        }
        if (answer.status === 'failed') total.failed += 1;
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

/** @public What a run of the summarizer reports besides its outcome. */
export interface SummaryRun {
  readonly outcome: CaseSummaryOutcome;
  /** The number of requests the click made to the provider. */
  readonly calls: number;
}

/** @public A summarizer of the evaluation: the product's own summarizer, with the settings and instructions of the run, over the provider it is given. */
export interface EvalSummarizer {
  readonly summarize: (reading: SummaryReading, signal: AbortSignal) => Promise<SummaryRun>;
  /** The SHA-256 of the instructions of the run. */
  readonly instructionsSha256: string;
  readonly instructions: string;
}

/** @public The product's summarizer built for a run of the evaluation command, over a provider the command holds, with the observer the command passes. Its record is kept in memory and its audit events go nowhere. */
export async function evalSummarizer(options: { readonly provider: ModelProvider; readonly settings: SummarySettings; readonly env: Env; readonly observe: (observation: ReplyObservation) => void; readonly shippedDirectory?: string }): Promise<{ readonly ok: true; readonly summarizer: EvalSummarizer } | { readonly ok: false; readonly problems: readonly string[] }> {
  const loaded = await loadSummaryInstructions({ env: options.env, ...(options.shippedDirectory === undefined ? {} : { shippedDirectory: options.shippedDirectory }) });
  if (!loaded.ok) return { ok: false, problems: loaded.problems };
  const { instructions } = loaded;
  const model = createAuditedModelCall({ provider: options.provider, configuration: { model: options.settings.model }, sink: { record: async () => undefined } });
  const keys = { current: { kid: 'eval0000', bytes: Buffer.alloc(32, 1) } };
  const store = createMemorySummaryRunStore();
  const summarizer = createCaseSummarizer({
    settings: options.settings,
    instructions,
    model: () => model,
    audit: () => ({ record: async () => undefined }),
    tokenKeys: () => keys,
    runs: () => store,
    availability: () => ({ available: true }),
    observe: options.observe,
  });
  return {
    ok: true,
    summarizer: {
      instructionsSha256: instructions.sha256,
      instructions: instructions.text,
      async summarize(reading, signal) {
        const before = store.runs.length;
        const outcome = await summarizer.summarize(
          { actorId: 'summary-eval', actorRole: 'investigator', traceId: 'summary-eval', policyVersion: 'eval', request: { investigationId: '0192f000-0000-7000-8000-00000000e7a1', sourceId: 'eval', entities: reading.nodes.map((node) => node.ref), edges: [], aggregates: [], derived: [] }, reading },
          signal,
        );
        return { outcome, calls: store.runs[before]?.calls ?? 0 };
      },
    },
  };
}

