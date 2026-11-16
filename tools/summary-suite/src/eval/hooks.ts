import type { CaseSummaryOutcome, SummaryReading, SummarySentence } from '@neburyx/contracts';

/** The settings of a run that the command reads; the enterprise code holds the rest. */
export interface RunSettings {
  readonly model: string;
  readonly timeoutMs: number;
  readonly totalTimeoutMs: number;
  readonly maxCalls: number;
  readonly maxElements: number;
  readonly maxOutputTokens: number;
  readonly maxInputTokens: number;
  readonly retentionDays: number;
}

/** What the checks did to one reply, as the summarizer reports it to the command. */
export interface ReplyObservation {
  readonly written: readonly SummarySentence[];
  readonly kept: readonly SummarySentence[];
  readonly removed: number;
  readonly keysStripped: number;
  readonly keysRemoved: number;
  readonly verdictFound: boolean;
}

export interface BudgetUsage {
  readonly calls: number;
  readonly refused: number;
  readonly failed: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly withoutCounts: number;
}

export interface EvalSummarizer {
  readonly summarize: (reading: SummaryReading, signal: AbortSignal) => Promise<{ readonly outcome: CaseSummaryOutcome; readonly calls: number }>;
  readonly instructionsSha256: string;
  /** The instructions of the run, for the bytes of what the model is sent. */
  readonly instructions: string;
}

/** What the command needs of the enterprise code, which it may reach only through its entry script. A provider is opaque here: the command only passes it from one hook to another. */
export interface EvalHooks<Provider = unknown> {
  readonly settings: (env: Readonly<Record<string, string | undefined>>) => { readonly ok: true; readonly settings: RunSettings } | { readonly ok: false; readonly problems: readonly string[] };
  readonly scriptedProvider: (replyFor: (values: string) => string) => Provider;
  readonly liveProvider: (env: Readonly<Record<string, string | undefined>>, folder: string, settings: RunSettings) => Promise<{ readonly provider: Provider; readonly model: string }>;
  readonly budgeted: (inner: Provider, budget: number, onRequest: (values: string) => void) => { readonly provider: Provider; readonly usage: () => BudgetUsage };
  readonly summarizer: (options: { readonly provider: Provider; readonly settings: RunSettings; readonly env: Readonly<Record<string, string | undefined>>; readonly observe: (observation: ReplyObservation) => void }) => Promise<{ readonly ok: true; readonly summarizer: EvalSummarizer } | { readonly ok: false; readonly problems: readonly string[] }>;
}
