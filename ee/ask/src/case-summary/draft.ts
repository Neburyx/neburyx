import { type SummaryFailureKind, type SummarySentence } from '@neburyx/contracts';
import type { AuditedCallContext, AuditedModelCall } from '../audited.js';
import type { FailureCode, ModelAnswer } from '../provider.js';
import type { SummaryCallEnd } from './run-store.js';
import { MAX_SUMMARY_SENTENCES } from './instructions.js';

/** The output limit of a summary call, in tokens. */
export const SUMMARY_MAX_OUTPUT_TOKENS = 2000;

const SUMMARY_PROMPT_ID = 'case-summary';
const SUMMARY_PROMPT_VERSION = 1;

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
  | { readonly status: 'drafted'; readonly sentences: readonly SummarySentence[]; readonly removed: number; readonly calls: number }
  | { readonly status: 'timeLimit'; readonly calls: number; readonly checked?: Checked }
  | { readonly status: 'failed'; readonly kind: SummaryFailureKind; readonly calls: number; readonly checked?: Checked };

export interface DraftOptions {
  readonly call: AuditedModelCall;
  readonly context: AuditedCallContext;
  readonly instructions: string;
  readonly values: string;
  /** The checks of a reply that fits the format: what is kept, how many were removed, and whether a sentence was removed for its wording. */
  readonly judge: (sentences: readonly SummarySentence[]) => { readonly kept: readonly SummarySentence[]; readonly removed: number; readonly verdictFound: boolean };
  readonly maxCalls: number;
  readonly totalTimeoutMs: number;
  readonly signal: AbortSignal;
  readonly now?: () => number;
  /** Told the number of calls made so far each time one is about to be made, so a failure that follows can say how many there were. */
  readonly onCall?: (calls: number) => void;
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
  while (calls < options.maxCalls) {
    if (options.signal.aborted) throw new Error('the request was cancelled');
    const remaining = options.totalTimeoutMs - (now() - started);
    if (remaining <= 0) return { status: 'timeLimit', calls, ...so() };
    const limit = new AbortController();
    const timer = setTimeout(() => limit.abort(), remaining);
    calls += 1;
    options.onCall?.(calls);
    try {
      const sentAt = now();
      await options.record?.beforeCall({ number: calls, instructions: options.instructions, values, startedAt: new Date(sentAt) });
      let answer: ModelAnswer;
      let received: ModelAnswer | undefined;
      try {
        answer = await options.call.call(
          { promptId: SUMMARY_PROMPT_ID, version: SUMMARY_PROMPT_VERSION, instructions: options.instructions, values },
          { ...options.context, onProviderAnswer: (returned) => void (received = returned) },
          AbortSignal.any([options.signal, limit.signal]),
        );
      } catch (error) {
        // a failure to record the audit event, after the provider answered, still leaves the record of the call with what the provider returned
        const end = received === undefined
          ? { number: calls, status: options.signal.aborted ? ('cancelled' as const) : ('failed' as const), failureKind: options.signal.aborted ? 'cancelled' : 'error', durationMs: now() - sentAt }
          : endOf(calls, received, now() - sentAt, options.signal.aborted ? 'client' : limit.signal.aborted ? 'limit' : undefined);
        // a record that cannot be written ends the click as unavailable, whatever the failure was
        await options.record?.afterCall(end);
        throw error;
      }
      await options.record?.afterCall(endOf(calls, answer, now() - sentAt, options.signal.aborted ? 'client' : limit.signal.aborted ? 'limit' : undefined));
      if (options.signal.aborted) throw new Error('the request was cancelled');
      if (limit.signal.aborted) return { status: 'timeLimit', calls, ...so() };
      if (answer.status === 'refused') return { status: 'failed', kind: 'refused', calls, ...so() };
      if (answer.status === 'failed') return { status: 'failed', kind: FAILURE_KINDS[answer.code], calls, ...so() };
      const sentences = parseReply(answer.text);
      if (sentences === undefined) {
        values = `${options.values}\n\n${FORMAT_NOTE}`;
        continue;
      }
      const judged = options.judge(sentences);
      checked = { kept: judged.kept.length, removed: judged.removed };
      if ((judged.verdictFound || judged.kept.length === 0) && calls < options.maxCalls) {
        values = `${options.values}\n\n${judged.verdictFound ? VERDICT_NOTE : NOTHING_LEFT_NOTE}`;
        continue;
      }
      return { status: 'drafted', sentences: judged.kept, removed: judged.removed, calls };
    } finally {
      clearTimeout(timer);
    }
  }
  return { status: 'failed', kind: 'format', calls, ...so() };
}
