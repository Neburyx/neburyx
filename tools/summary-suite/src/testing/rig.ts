import {
  buildSummaryInstructions,
  createAuditedModelCall,
  createCaseSummarizer,
  createMemorySummaryRunStore,
  promptRecordOf,
  type ModelAnswer,
  type ModelProvider,
  type ModelRequest,
} from '@neburyx/ee-ask';
import type { AuditEvent, CaseSummarizer, CaseSummaryInput, CaseSummaryOutcome, SummaryReading, SummarySentence } from '@neburyx/contracts';
import { z } from 'zod';

const summaryReplySchema = z.strictObject({ sentences: z.array(z.strictObject({ text: z.string().min(1), cites: z.array(z.string().min(1)) })).max(12) });

export const KEYS = { current: { kid: 'abcd1234', bytes: Buffer.alloc(32, 7) } };
export const INVESTIGATION = '0192f000-0000-7000-8000-000000000042';

const DEFAULT_SETTINGS = { model: 'claude-sonnet-5-5', timeoutMs: 60_000, totalTimeoutMs: 180_000, maxCalls: 5, maxElements: 300, maxOutputTokens: 4000, maxInputTokens: 100_000, retentionDays: 30 };

/** What the scripted model answers for one request: the text of a reply that fits, a failure, or a function of the request. */
export type Scripted = string | ModelAnswer | ((request: ModelRequest, call: number, signal: AbortSignal) => string | ModelAnswer | Promise<string | ModelAnswer>);

export interface RigOptions {
  /** The answers, in order; the last one repeats. */
  readonly replies: readonly Scripted[];
  readonly settings?: Partial<typeof DEFAULT_SETTINGS>;
  readonly prompt?: string;
  readonly typology?: string;
  /** The instructions as the product loads them from its files; they replace `prompt` and `typology`. */
  readonly instructions?: { readonly text: string; readonly sha256: string };
  readonly now?: () => number;
  /** The factory of the summarizer; a test that weakens one check passes the one built from the source files. */
  readonly factory?: typeof createCaseSummarizer;
}

/** A scripted failure of the provider: the call ends with the code, as a provider's failure does. */
export const failure = (code: 'timeout' | 'unreachable' | 'rejected' | 'rate-limited' | 'provider-error' | 'bad-reply' | 'truncated'): Scripted => (request) => ({ status: 'failed', code, prompt: promptRecordOf(request) });

export const replyOf = (...sentences: readonly { readonly text: string; readonly cites: readonly string[] }[]): string => JSON.stringify({ sentences });

/** The references a request names for a view: the entities, and the relationships by the kind of their reference. */
function requestOf(view: SummaryReading): CaseSummaryInput['request'] {
  const edges = view.edges.flatMap((each) => ('stableId' in each.ref ? [each.ref] : []));
  const aggregates = view.edges.flatMap((each) => ('aggregate' in each.ref ? [each.ref] : []));
  const derived = view.edges.flatMap((each) => ('derived' in each.ref ? [each.ref] : []));
  return { investigationId: INVESTIGATION, sourceId: 'demo', entities: view.nodes.map((each) => each.ref), edges, aggregates, derived };
}

export interface Rig {
  /** The summarizer itself, for a test that mounts it in the real application. */
  readonly summarizer: CaseSummarizer;
  readonly summarize: (view: SummaryReading, signal?: AbortSignal) => Promise<CaseSummaryOutcome>;
  readonly requests: ModelRequest[];
  /** The text of every reply the model gave, in order. */
  readonly replies: string[];
  readonly events: AuditEvent[];
  readonly store: ReturnType<typeof createMemorySummaryRunStore>;
  readonly instructions: ReturnType<typeof buildSummaryInstructions>;
  readonly settings: typeof DEFAULT_SETTINGS;
}

/** The real summarizer (assembly, size guard, drafting loop, checks, sealing, run record, events) over a scripted model; it keeps what the model received and what was recorded. */
export function startRig(options: RigOptions): Rig {
  const requests: ModelRequest[] = [];
  const replies: string[] = [];
  const events: AuditEvent[] = [];
  const store = createMemorySummaryRunStore();
  let index = 0;
  const provider: ModelProvider = {
    complete: async (request, signal) => {
      requests.push(request);
      const scripted = options.replies[Math.min(index, options.replies.length - 1)];
      index += 1;
      const answer = typeof scripted === 'function' ? await scripted(request, index, signal) : scripted;
      if (answer === undefined) throw new Error('the rig was given no reply');
      if (typeof answer !== 'string') {
        if (answer.status === 'ok') replies.push(answer.text);
        return answer;
      }
      replies.push(answer);
      return { status: 'ok', text: answer, usage: { kind: 'known', inputTokens: 100, outputTokens: 20 }, model: 'claude-sonnet-5-5', prompt: promptRecordOf(request) };
    },
  };
  const model = createAuditedModelCall({ provider, configuration: { model: 'claude-sonnet-5-5' }, sink: { record: async (event) => void events.push(event) } });
  const settings = { ...DEFAULT_SETTINGS, ...options.settings };
  const instructions = options.instructions ?? buildSummaryInstructions(options.prompt ?? 'PROMPT', options.typology ?? 'TYPOLOGY');
  const summarizer = (options.factory ?? createCaseSummarizer)({
    settings,
    instructions,
    model: () => model,
    audit: () => ({ record: async (event) => void events.push(event) }),
    tokenKeys: () => KEYS,
    runs: () => store,
    availability: () => ({ available: true }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const inputOf = (view: SummaryReading, overrides: Partial<CaseSummaryInput> = {}): CaseSummaryInput => ({
    actorId: 'analyst-1',
    actorRole: 'investigator',
    traceId: 'trace-1',
    policyVersion: 'policy-1',
    request: requestOf(view),
    reading: view,
    ...overrides,
  });
  const summarize = (view: SummaryReading, signal: AbortSignal = new AbortController().signal): Promise<CaseSummaryOutcome> => summarizer.summarize(inputOf(view), signal);
  return { summarizer, summarize, requests, replies, events, store, instructions, settings };
}

/** The sentences of the last reply that fits the reply format: the reply the checks judged last. */
export function checkedReplyOf(replies: readonly string[]): SummarySentence[] {
  for (const text of [...replies].reverse()) {
    try {
      const parsed: unknown = JSON.parse(text);
      const sentences = summaryReplySchema.safeParse(parsed);
      if (sentences.success) return sentences.data.sentences;
    } catch {
      continue;
    }
  }
  return [];
}
