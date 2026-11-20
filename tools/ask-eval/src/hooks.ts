import type { AskClassification, AssistantRouterReply } from '@neburyx/contracts';

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

/** What the router returned for one message: its route, no route after the one repeat, or no reply the run could use. */
export type RouteOutcome = (
  | { readonly status: 'routed'; readonly reply: AssistantRouterReply; readonly calls: number }
  | { readonly status: 'unplaced'; readonly calls: number }
  | { readonly status: 'too-large' }
  | { readonly status: 'failed'; readonly code: string }
) & {
  /** The stable id each key of the thread's context stood for in this message. */
  readonly keys: Readonly<Record<string, string>>;
};

/** An earlier turn of a thread as its labels give it. */
export interface LabelledTurn {
  readonly route: 'view' | 'ask' | 'refuse';
  readonly intent?: string;
  readonly entities?: Readonly<Record<string, string>>;
  readonly cause?: string;
  /** For a view, the elements it shows, which the product's view answer cites. */
  readonly cited?: readonly { readonly entityType: string; readonly stableId: string }[];
}

interface RouteInput {
  readonly message: string;
  readonly viewElementKeys: readonly string[];
  readonly earlier?: readonly LabelledTurn[];
}

/** What the tool needs of the assistant's router, which it may reach only through its entry script. */
export interface AssistantHooks {
  readonly routeMessage: (source: SourceHandle, provider: unknown, model: string, input: RouteInput) => Promise<RouteOutcome>;
  /** The values of the two requests a message can make: the first, and the repeat after a reply that is not a route. */
  readonly routerRequests: (source: SourceHandle, input: RouteInput) => Promise<{ readonly first: string; readonly repeat: string }>;
  /** The key the thread's context gives each element of the labelled earlier turns, with the stable id it stands for. */
  readonly contextKeys: (source: SourceHandle, earlier: readonly LabelledTurn[]) => Promise<Readonly<Record<string, string>>>;
  /** What a run will use, without a key: the model (the setting or the one given), the effort and the output limit of a reply. */
  readonly assistantRunSettings: (env: Readonly<Record<string, string | undefined>>, model?: string) => { readonly model: string; readonly effort: string; readonly outputLimit: number };
  readonly liveAssistantProvider: (env: Readonly<Record<string, string | undefined>>, folder: string, model?: string) => Promise<{ readonly provider: unknown; readonly model: string; readonly effort: string; readonly outputLimit: number }>;
  /** One message through the real assistant turn over a stand-in for the capabilities, with the tool loop's steps at the given number. */
  readonly loopCostRun: (source: SourceHandle, provider: unknown, model: string, input: RouteInput, steps: number) => Promise<LoopCostRun>;
  /** The limits of a turn as the settings of the assistant have them: the default a turn runs under and the highest value a setting accepts. */
  readonly assistantLimits: () => Readonly<Record<'steps' | 'calls' | 'inputTokens' | 'outputTokens' | 'words' | 'threadRead', { readonly default: number; readonly highest: number }>>;
  /** The tool steps a turn may take by default and the model calls it may make. */
  readonly loopDefaults: () => { readonly steps: number; readonly maxCalls: number };
  /** The size in bytes of the instruction text the router sends for a source. */
  readonly routerTextBytes: (source: SourceHandle) => Promise<number>;
  /** How many turns of a thread the router is shown. */
  readonly contextTurns: () => number;
  /** The SHA-256 of the instruction text the router sends for a source. */
  readonly routerTextSha256: (source: SourceHandle) => Promise<string>;
}

/** What one message cost on the real assistant turn: the model calls by prompt, the tokens, the time and the route the turn took. */
export interface LoopCostRun {
  readonly route: string;
  readonly calls: Readonly<Record<string, number>>;
  readonly total: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly ms: number;
  readonly stepCalls: number;
  readonly steps: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly rows: number;
}
