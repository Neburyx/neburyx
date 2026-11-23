import { ERROR_TABLE, isTokenCount, parseAiAuditDetail, tokenCount, type AiAuditDetail, type AuditEvent, type AuditResult, type AuditSink, type ErrorCode } from '@neburyx/contracts';
import type { ProviderConfiguration } from './provider-configuration.js';
import { promptRecordOf, type ModelAnswer, type ModelProvider, type ModelRequest, type PromptRecord, type TokenUsage } from './provider.js';

/** Who asked and where it belongs: a model request carries none of it. */
export interface AuditedCallContext {
  /** The action the audit event of the call carries. */
  readonly action: string;
  readonly actorId: string;
  readonly actorRole: AuditEvent['actorRole'];
  readonly traceId: string;
  readonly investigationId?: string;
  readonly sourceId?: string;
  /** The record of the click this call belongs to, named in the call's event; Ask has none. */
  readonly runId?: string;
  /** Called with the provider's answer the moment it returns, before the audit event is written, so a record of the call can hold the answer even when the event cannot be written. Never part of an event. */
  readonly onProviderAnswer?: (answer: ModelAnswer) => void;
  /** The saved patterns the request offered: their number and the SHA-256 of the text sent, never a pattern. */
  readonly patternCatalog?: { readonly count: number; readonly sha256: string };
}

/** Thrown when a model call could not be recorded: the answer is discarded and never carried by the error. */
export class AuditUnavailableError extends Error {
  readonly code: Extract<ErrorCode, 'AUDIT_UNAVAILABLE'> = 'AUDIT_UNAVAILABLE';

  constructor() {
    super(ERROR_TABLE.AUDIT_UNAVAILABLE.message);
  }
}

export interface AuditedModelOptions {
  readonly provider: ModelProvider;
  /** The configuration the provider was built from: its model is the one a refused or failed call is recorded under. */
  readonly configuration: Pick<ProviderConfiguration, 'model'>;
  readonly sink: AuditSink;
}

export interface AuditedModelCall {
  /** The configured model, the reference a failed or refused call is recorded under. */
  readonly modelRef: string;
  readonly call: (request: ModelRequest, context: AuditedCallContext, signal: AbortSignal) => Promise<ModelAnswer>;
  /**
   * The same call as a provider, for one context. Unlike a bare provider it can reject with `AuditUnavailableError` (the event could not be written, or the answer's prompt differs from the one sent),
   * and it rethrows what the provider threw after recording the failure; a route that takes it as a provider maps both.
   */
  readonly asProvider: (context: AuditedCallContext) => ModelProvider;
}

/** What the audit event accepts as a prompt id: the rule of the contract's `label`. */
const AUDIT_LABEL = /^[A-Za-z0-9._:/-]{1,200}$/;

const UNKNOWN_USAGE: TokenUsage = { kind: 'unknown' };

/** A count that is not a non-negative whole number is `unknown`, never a number. */
function countOf(value: number): AiAuditDetail['tokensIn'] {
  return isTokenCount(value) ? tokenCount(value) : 'unknown';
}

function sameRecord(left: PromptRecord, right: PromptRecord): boolean {
  return left.id === right.id && left.version === right.version && left.sha256 === right.sha256;
}

export interface CallRecorder {
  /** Hands the event of one finished call to the sink; an event that cannot be built rejects with `AuditUnavailableError`. */
  readonly record: (context: AuditedCallContext, prompt: PromptRecord, outcome: CallOutcome) => Promise<void>;
}

export interface CallOutcome {
  readonly result: AuditResult;
  readonly modelRef: string;
  readonly usage: TokenUsage;
  /** On a failed call: the class and the code of the error the provider's client threw, as short codes. */
  readonly failure?: { readonly errorClass: string; readonly errorCode?: string };
}

export function createCallRecorder(options: Pick<AuditedModelOptions, 'sink'>): CallRecorder {
  const { sink } = options;

  function eventOf(context: AuditedCallContext, prompt: PromptRecord, outcome: CallOutcome): AuditEvent {
    const counts =
      outcome.usage.kind === 'known'
        ? {
            tokensIn: countOf(outcome.usage.inputTokens),
            tokensOut: countOf(outcome.usage.outputTokens),
            cacheReadTokens: outcome.usage.cacheReadTokens === undefined ? ('unknown' as const) : countOf(outcome.usage.cacheReadTokens),
            cacheWriteTokens: outcome.usage.cacheWriteTokens === undefined ? ('unknown' as const) : countOf(outcome.usage.cacheWriteTokens),
          }
        : { tokensIn: 'unknown' as const, tokensOut: 'unknown' as const, cacheReadTokens: 'unknown' as const, cacheWriteTokens: 'unknown' as const };
    const ai = parseAiAuditDetail({
      modelRef: outcome.modelRef,
      promptId: prompt.id,
      promptVersion: String(prompt.version),
      promptSha256: prompt.sha256,
      ...(context.runId === undefined ? {} : { runId: context.runId }),
      ...(context.patternCatalog === undefined ? {} : { patternCatalog: context.patternCatalog }),
      ...counts,
      ...(outcome.failure === undefined ? {} : { failure: outcome.failure }),
    });
    return {
      actorId: context.actorId,
      actorRole: context.actorRole,
      action: context.action,
      result: outcome.result,
      ...(context.sourceId === undefined ? {} : { sourceId: context.sourceId }),
      ...(context.investigationId === undefined ? {} : { investigationId: context.investigationId }),
      traceId: context.traceId,
      detail: { ai },
    };
  }

  /** Hands the event to the sink, which queues it: the answer of the provider does not wait for the store and is not discarded when the event cannot be written. An event that cannot be built is the only failure that withholds the answer. */
  async function record(context: AuditedCallContext, prompt: PromptRecord, outcome: CallOutcome): Promise<void> {
    let event: AuditEvent;
    try {
      event = eventOf(context, prompt, outcome);
    } catch {
      // an event that cannot be built from the call is a fault of the call itself: nothing of it leaves
      throw new AuditUnavailableError();
    }
    // the sink queues the event and counts and logs its own failures; a failure here does not discard the answer
    await sink.record(event).catch(() => undefined);
  }

  return { record };
}

export function createAuditedModelCall(options: AuditedModelOptions): AuditedModelCall {
  const { provider, configuration, sink } = options;

  const { record } = createCallRecorder({ sink });

  async function call(request: ModelRequest, context: AuditedCallContext, signal: AbortSignal): Promise<ModelAnswer> {
    // an id the audit event cannot hold is refused before anything is sent, so no call goes out without its event
    if (!AUDIT_LABEL.test(request.promptId) || !Number.isInteger(request.version) || request.version < 0) throw new RangeError('the prompt id or version cannot be recorded in the audit');
    const sent = promptRecordOf(request);
    const failed: CallOutcome = { result: 'failed', modelRef: configuration.model, usage: UNKNOWN_USAGE };
    let answer: ModelAnswer;
    try {
      answer = await provider.complete(request, signal);
      context.onProviderAnswer?.(answer);
    } catch (error) {
      await record(context, sent, failed);
      throw error;
    }
    if (!sameRecord(answer.prompt, sent)) {
      await record(context, sent, failed);
      throw new AuditUnavailableError();
    }
    switch (answer.status) {
      case 'ok':
        await record(context, sent, { result: 'success', modelRef: answer.model, usage: answer.usage });
        return answer;
      case 'refused':
        await record(context, sent, { result: 'refused', modelRef: configuration.model, usage: answer.usage });
        return answer;
      case 'failed':
        await record(context, sent, { ...failed, usage: answer.usage ?? UNKNOWN_USAGE });
        return answer;
      default: {
        const unreachable: never = answer;
        return unreachable;
      }
    }
  }

  return { modelRef: configuration.model, call, asProvider: (context) => ({ complete: (request, signal) => call(request, context, signal) }) };
}
