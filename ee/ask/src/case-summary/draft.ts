import { type SummaryFailureKind, type SummarySentence } from '@neburyx/contracts';
import type { AuditedCallContext, AuditedModelCall } from '@neburyx/ee-ai-runtime';
import type { FailureCode, ModelAnswer } from '@neburyx/ee-ai-runtime';
import type { SummaryCallEnd } from './run-store.js';
import { estimateTokens } from './assemble.js';
import { MAX_SUMMARY_SENTENCES } from './instructions.js';

const SUMMARY_PROMPT_ID = 'case-summary';
const SUMMARY_PROMPT_VERSION = 1;

const NO_GUARD = Number.POSITIVE_INFINITY;

function endOf(number: number, answer: ModelAnswer, durationMs: number, cancelled: 'client' | 'limit' | undefined): Omit<SummaryCallEnd, 'runId'> {
  const tokens = 'usage' in answer && answer.usage?.kind === 'known' ? { tokensIn: answer.usage.inputTokens, tokensOut: answer.usage.outputTokens } : {};
  const cancel = cancelled === undefined ? {} : { status: 'cancelled' as const, failureKind: cancelled === 'limit' ? 'timeLimit' : 'cancelled' };
  if (answer.status === 'ok') return { number, status: 'answered', replyText: answer.text, durationMs, ...tokens, ...cancel };
  const received = answer.received === undefined ? {} : { replyText: answer.received };
  if (answer.status === 'refused') return { number, status: 'refused', ...received, durationMs, ...tokens, ...cancel };
  return { number, status: 'failed', failureKind: FAILURE_KINDS[answer.code], ...received, durationMs, ...tokens, ...cancel };
}

const FORMAT_NOTE = 'Your last reply did not fit the reply format. Reply again, in the reply format only.';
const VERDICT_NOTE = 'Your last reply stated a conclusion. Describe only what the elements show.';
const NOTHING_LEFT_NOTE = 'No sentence of your last reply passed the checks. Reply again, with sentences that cite the elements given.';

const FAILURE_KINDS: Readonly<Record<FailureCode, SummaryFailureKind>> = {
  timeout: 'timeout',
  unreachable: 'unreachable',
  rejected: 'rejected',
  'rate-limited': 'rate-limited',
  'provider-error': 'provider-error',
  'bad-reply': 'bad-reply',
  truncated: 'truncated',
};

/** What the checks left of the last reply that was checked. */
export interface Checked {
  readonly kept: number;
  readonly removed: number;
}

export type Drafted =
  | { readonly status: 'drafted'; readonly sentences: readonly SummarySentence[]; readonly removed: number; readonly calls: number; /** Whether the last reply held verdict wording, with no call left to repeat it. */ readonly verdictFound: boolean; /** The model the provider says produced the reply that was accepted. */ readonly model: string }
  | { readonly status: 'tooLarge'; readonly calls: number }
  | { readonly status: 'timeLimit'; readonly calls: number; readonly checked?: Checked }
  | { readonly status: 'failed'; readonly kind: SummaryFailureKind; readonly calls: number; readonly checked?: Checked };

interface Judgement {
  readonly kept: readonly SummarySentence[];
  readonly removed: number;
  readonly verdictFound: boolean;
}

interface CheckRefused {
  readonly refused: 'worker-failed' | 'timeout' | 'cancelled';
}

/** What a caller keeps of one model call besides the summary's own record: the run it belongs to, what the provider returned, and how the call ended. */
interface CallTrace {
  readonly runId?: string;
  received(answer: ModelAnswer): void;
  end(outcome: { readonly error?: unknown; readonly aborted: boolean }): void;
}

export interface DraftOptions {
  readonly call: AuditedModelCall;
  readonly context: AuditedCallContext;
  readonly instructions: string;
  readonly values: string;
  /** The prompt the calls name; the case summary's when absent. */
  readonly prompt?: { readonly id: string; readonly version: number };
  /** The most the whole text of one submission may weigh, in the estimate of tokens; none when absent. A submission over it is not sent, and the draft ends as too large. */
  readonly maxInputTokens?: number;
  /** The checks of a reply that fits the format: what is kept, how many were removed, and whether a sentence was removed for its wording. */
  readonly judge: (sentences: readonly SummarySentence[], signal: AbortSignal) => Promise<Judgement | CheckRefused> | Judgement | CheckRefused;
  /** Told why a check could not run, which is not a reply that cited nothing: the click ends at once, with no further call. */
  readonly onCheckRefused?: (reason: CheckRefused['refused']) => void;
  readonly maxCalls: number;
  /** The most calls that may repeat a reply that did not pass; the case summary repeats as often as its call limit allows. */
  readonly repeats?: number;
  readonly totalTimeoutMs: number;
  readonly signal: AbortSignal;
  readonly now?: () => number;
  /** Told the number of calls made so far each time one is about to be made, so a failure that follows can say how many there were. */
  readonly onCall?: (calls: number) => void;
  /** Told as each call is about to be made, so the caller can keep a record of it; the case summary keeps its own. */
  readonly trace?: (call: { readonly number: number; readonly instructions: string; readonly values: string }) => CallTrace;
  /** Keeps the record of each request: written before the request is made, finished when it ends. A write that fails ends the click. */
  readonly record?: {
    beforeCall(call: { readonly number: number; readonly instructions: string; readonly values: string; readonly startedAt: Date }): Promise<void>;
    afterCall(end: Omit<SummaryCallEnd, 'runId'>): Promise<void>;
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The sentences of a reply of the exact shape `{"sentences":[{"text","cites"}]}` with at most the sentence limit; anything else is undefined. */
function parseReply(text: string): readonly SummarySentence[] | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(json) || Object.keys(json).join() !== 'sentences' || !Array.isArray(json['sentences']) || json['sentences'].length > MAX_SUMMARY_SENTENCES) return undefined;
  const sentences: SummarySentence[] = [];
  for (const entry of json['sentences'] as unknown[]) {
    if (!isRecord(entry) || Object.keys(entry).sort().join() !== 'cites,text') return undefined;
    const { text: sentence, cites } = entry;
    if (typeof sentence !== 'string' || sentence === '' || !Array.isArray(cites) || !cites.every((cite): cite is string => typeof cite === 'string' && cite !== '')) return undefined;
    sentences.push({ text: sentence, cites });
  }
  return sentences;
}

/**
 * Calls the model until a reply fits the reply format, within the call limit and the total time limit. A reply that is whole but does not fit gets one more call with a fixed note; anything the provider itself
 * fails at ends the click at once. The call in flight is aborted when the total time is spent or the client gives up, and no call follows.
 */
export async function draftSummary(options: DraftOptions): Promise<Drafted> {
  const now = options.now ?? Date.now;
  const started = now();
  let calls = 0;
  let values = options.values;
  let checked: Checked | undefined;
  const so = (): { readonly checked?: Checked } => (checked === undefined ? {} : { checked });
  const callLimit = Math.min(options.maxCalls, (options.repeats ?? Number.POSITIVE_INFINITY) + 1);
  while (calls < callLimit) {
    if (options.signal.aborted) throw new Error('the request was cancelled');
    const remaining = options.totalTimeoutMs - (now() - started);
    if (remaining <= 0) return { status: 'timeLimit', calls, ...so() };
    const limit = new AbortController();
    const timer = setTimeout(() => limit.abort(), remaining);
    const number = calls + 1;
    try {
      const sentAt = now();
      if (estimateTokens(options.instructions, values) > (options.maxInputTokens ?? NO_GUARD)) return { status: 'tooLarge', calls };
      await options.record?.beforeCall({ number, instructions: options.instructions, values, startedAt: new Date(sentAt) });
      if (options.signal.aborted) {
        // the client gave up while the call was being recorded: the record ends as cancelled and the provider is never asked
        await options.record?.afterCall({ number, status: 'cancelled', failureKind: 'cancelled', durationMs: now() - sentAt });
        throw new Error('the request was cancelled');
      }
      // only a call that is sent is counted
      calls = number;
      options.onCall?.(calls);
      const trace = options.trace?.({ number, instructions: options.instructions, values });
      let answer: ModelAnswer;
      let received: ModelAnswer | undefined;
      try {
        answer = await options.call.call(
          { promptId: options.prompt?.id ?? SUMMARY_PROMPT_ID, version: options.prompt?.version ?? SUMMARY_PROMPT_VERSION, instructions: options.instructions, values },
          { ...options.context, ...(trace?.runId === undefined ? {} : { runId: trace.runId }), onProviderAnswer: (returned) => void ((received = returned), trace?.received(returned)) },
          AbortSignal.any([options.signal, limit.signal]),
        );
      } catch (error) {
        trace?.end({ error, aborted: options.signal.aborted });
        // a failure to record the audit event, after the provider answered, still leaves the record of the call with what the provider returned
        const endNow = () =>
          received === undefined
            ? { number: calls, status: options.signal.aborted ? ('cancelled' as const) : ('failed' as const), failureKind: options.signal.aborted ? 'cancelled' : 'error', durationMs: now() - sentAt }
            : endOf(calls, received, now() - sentAt, options.signal.aborted ? 'client' : limit.signal.aborted ? 'limit' : undefined);
        const first = endNow();
        // a record that cannot be written ends the click as unavailable, whatever the failure was
        await options.record?.afterCall(first);
        // a cancel that arrived while the record was written still marks the call
        if (first.status !== 'cancelled' && options.signal.aborted) await options.record?.afterCall(endNow());
        throw error;
      }
      trace?.end({ aborted: options.signal.aborted });
      const clientGaveUp = options.signal.aborted;
      await options.record?.afterCall(endOf(calls, answer, now() - sentAt, clientGaveUp ? 'client' : limit.signal.aborted ? 'limit' : undefined));
      // a cancel that arrived while the record was written still marks the call
      if (!clientGaveUp && options.signal.aborted) await options.record?.afterCall(endOf(calls, answer, now() - sentAt, 'client'));
      if (options.signal.aborted) throw new Error('the request was cancelled');
      if (limit.signal.aborted) return { status: 'timeLimit', calls, ...so() };
      if (answer.status === 'refused') return { status: 'failed', kind: 'refused', calls, ...so() };
      if (answer.status === 'failed') return { status: 'failed', kind: FAILURE_KINDS[answer.code], calls, ...so() };
      const model = answer.model;
      const sentences = parseReply(answer.text);
      if (sentences === undefined) {
        values = `${options.values}\n\n${FORMAT_NOTE}`;
        continue;
      }
      const judged = await options.judge(sentences, AbortSignal.any([options.signal, limit.signal]));
      if ('refused' in judged) {
        if (judged.refused !== 'cancelled') options.onCheckRefused?.(judged.refused);
        if (options.signal.aborted) throw new Error('the request was cancelled');
        if (limit.signal.aborted) return { status: 'timeLimit', calls, ...so() };
        throw new Error('a check of the reply could not run');
      }
      checked = { kept: judged.kept.length, removed: judged.removed };
      if ((judged.verdictFound || judged.kept.length === 0) && calls < callLimit) {
        values = `${options.values}\n\n${judged.verdictFound ? VERDICT_NOTE : NOTHING_LEFT_NOTE}`;
        continue;
      }
      return { status: 'drafted', sentences: judged.kept, removed: judged.removed, calls, verdictFound: judged.verdictFound, model };
    } finally {
      clearTimeout(timer);
    }
  }
  return { status: 'failed', kind: 'format', calls, ...so() };
}
