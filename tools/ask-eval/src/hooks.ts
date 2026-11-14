import type { AskClassification } from '@neburyx/contracts';

/** A source whose folder has been loaded: the tool reads only these fields; the rest is for the classifier. */
export interface SourceHandle {
  readonly sourceId: string;
  readonly classificationSha256: string;
  readonly intents: readonly { readonly name: string; readonly parameters: readonly string[] }[];
}

export type FailureCode = 'timeout' | 'unreachable' | 'rejected' | 'rate-limited' | 'provider-error' | 'bad-reply' | 'truncated';
export const FAILURE_CODES: readonly FailureCode[] = ['timeout', 'unreachable', 'rejected', 'rate-limited', 'provider-error', 'bad-reply', 'truncated'];

export type RecordedAnswer = { readonly reply: string } | { readonly declined: true } | { readonly failure: FailureCode };

interface RunUsage {
  readonly calls: number;
  readonly failed: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly withoutCounts: number;
}

/** What the tool needs of the enterprise code, which it may reach only through its entry script. A provider is opaque here. */
export interface EvalHooks {
  readonly loadSource: (folder: string, sourceId: string) => Promise<{ readonly ok: true; readonly source: SourceHandle } | { readonly ok: false; readonly problems: readonly string[] }>;
  readonly classify: (source: SourceHandle, provider: unknown, model: string, question: string) => Promise<AskClassification>;
  readonly replayProvider: (answers: ReadonlyMap<string, RecordedAnswer>) => unknown;
  readonly recordingProvider: (inner: unknown, budget: number) => { readonly provider: unknown; readonly answers: () => ReadonlyMap<string, RecordedAnswer>; readonly usage: () => RunUsage };
  readonly runSettings: (env: Readonly<Record<string, string | undefined>>) => { readonly model: string; readonly effort: string };
  readonly liveProvider: (env: Readonly<Record<string, string | undefined>>, folder: string) => Promise<{ readonly provider: unknown; readonly model: string; readonly effort: string }>;
}
