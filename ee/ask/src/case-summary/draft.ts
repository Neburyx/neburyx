import { type SummaryFailureKind, type SummarySentence } from '@neburyx/contracts';
import type { AuditedCallContext, AuditedModelCall } from '../audited.js';
import type { FailureCode } from '../provider.js';
import { MAX_SUMMARY_SENTENCES } from './instructions.js';

/** The output limit of a summary call, in tokens. */
export const SUMMARY_MAX_OUTPUT_TOKENS = 2000;

const SUMMARY_PROMPT_ID = 'case-summary';
const SUMMARY_PROMPT_VERSION = 1;

const FORMAT_NOTE = 'Your last reply did not fit the reply format. Reply again, in the reply format only.';

const FAILURE_KINDS: Readonly<Record<FailureCode, SummaryFailureKind>> = {
  timeout: 'timeout',
  unreachable: 'unreachable',
  rejected: 'rejected',
  'rate-limited': 'rate-limited',
  'provider-error': 'provider-error',
  'bad-reply': 'bad-reply',
  truncated: 'truncated',
};

export type Drafted =
  | { readonly status: 'drafted'; readonly sentences: readonly SummarySentence[]; readonly calls: number }
  | { readonly status: 'timeLimit'; readonly calls: number }
  | { readonly status: 'failed'; readonly kind: SummaryFailureKind; readonly calls: number };

export interface DraftOptions {
  readonly call: AuditedModelCall;
  readonly context: AuditedCallContext;
  readonly instructions: string;
  readonly values: string;
  readonly maxCalls: number;
  readonly totalTimeoutMs: number;
  readonly signal: AbortSignal;
  readonly now?: () => number;
  /** Told the number of calls made so far each time one is about to be made, so a failure that follows can say how many there were. */
  readonly onCall?: (calls: number) => void;
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
  while (calls < options.maxCalls) {
    if (options.signal.aborted) throw new Error('the request was cancelled');
    const remaining = options.totalTimeoutMs - (now() - started);
    if (remaining <= 0) return { status: 'timeLimit', calls };
    const limit = new AbortController();
    const timer = setTimeout(() => limit.abort(), remaining);
    calls += 1;
    options.onCall?.(calls);
    try {
      const answer = await options.call.call(
        { promptId: SUMMARY_PROMPT_ID, version: SUMMARY_PROMPT_VERSION, instructions: options.instructions, values },
        options.context,
        AbortSignal.any([options.signal, limit.signal]),
      );
      if (options.signal.aborted) throw new Error('the request was cancelled');
      if (limit.signal.aborted) return { status: 'timeLimit', calls };
      if (answer.status === 'refused') return { status: 'failed', kind: 'refused', calls };
      if (answer.status === 'failed') return { status: 'failed', kind: FAILURE_KINDS[answer.code], calls };
      const sentences = parseReply(answer.text);
      if (sentences !== undefined) return { status: 'drafted', sentences, calls };
      values = `${options.values}\n\n${FORMAT_NOTE}`;
    } finally {
      clearTimeout(timer);
    }
  }
  return { status: 'failed', kind: 'format', calls };
}
