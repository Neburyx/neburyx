import { ERROR_TABLE, isTokenCount, parseAiAuditDetail, tokenCount, type AiAuditDetail, type AuditEvent, type AuditResult, type AuditSink, type ErrorCode } from '@neburyx/contracts';
import type { AskConfiguration } from './configure.js';
import type { ModelAnswer, ModelProvider, ModelRequest, PromptId, PromptRecord, TokenUsage } from './provider.js';

/** The action an audit event of each prompt carries. */
export const AUDIT_ACTIONS: Readonly<Record<PromptId, string>> = {
  'ask.plan': 'ask.plan',
  'summary.view': 'ai.summary',
  'assistant.route': 'assistant.turn',
};

/** Who asked and where it belongs: a model request carries none of it. */
export interface AuditedCallContext {
  readonly actorId: string;
  readonly actorRole: AuditEvent['actorRole'];
  readonly traceId: string;
  readonly investigationId?: string;
  readonly sourceId?: string;
  /** The `type.property` names of the `pii` properties the request holds, never their values. */
  readonly piiPropertiesSent?: readonly string[];
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
  /** The configuration the provider was built from: its registry names the prompt whose template hash is audited, and its model is the one a refused or failed call is recorded under. */
  readonly configuration: Pick<AskConfiguration, 'registry' | 'model'>;
  readonly sink: AuditSink;
}

export interface AuditedModelCall {
  readonly call: (request: ModelRequest, context: AuditedCallContext, signal: AbortSignal) => Promise<ModelAnswer>;
  /**
   * The same call as a provider, for one context. Unlike a bare provider it can reject with `AuditUnavailableError` (the event could not be written, or the answer's prompt differs from the one resolved),
   * and it rethrows what the provider threw after recording the failure; a route that takes it as a provider maps both.
   */
  readonly asProvider: (context: AuditedCallContext) => ModelProvider;
}

interface Outcome {
  readonly result: AuditResult;
  readonly modelRef: string;
  readonly usage: TokenUsage;
}

const UNKNOWN_USAGE: TokenUsage = { kind: 'unknown' };

/** A count that is not a non-negative whole number is `unknown`, never a number. */
function countOf(value: number): AiAuditDetail['tokensIn'] {
  return isTokenCount(value) ? tokenCount(value) : 'unknown';
}

function sameRecord(left: PromptRecord, right: PromptRecord): boolean {
  return left.id === right.id && left.version === right.version && left.source === right.source && left.sha256 === right.sha256;
}

export function createAuditedModelCall(options: AuditedModelOptions): AuditedModelCall {
  const { provider, configuration, sink } = options;

  function eventOf(request: ModelRequest, context: AuditedCallContext, prompt: PromptRecord, outcome: Outcome): AuditEvent {
    const counts = outcome.usage.kind === 'known' ? { tokensIn: countOf(outcome.usage.inputTokens), tokensOut: countOf(outcome.usage.outputTokens) } : { tokensIn: 'unknown' as const, tokensOut: 'unknown' as const };
    const ai = parseAiAuditDetail({
      modelRef: outcome.modelRef,
      promptId: prompt.id,
      promptVersion: String(prompt.version),
      promptSha256: prompt.sha256,
      ...(context.piiPropertiesSent === undefined || context.piiPropertiesSent.length === 0 ? {} : { piiPropertiesSent: context.piiPropertiesSent }),
      ...counts,
    });
    return {
      actorId: context.actorId,
      actorRole: context.actorRole,
      action: AUDIT_ACTIONS[request.promptId],
      result: outcome.result,
      ...(context.sourceId === undefined ? {} : { sourceId: context.sourceId }),
      ...(context.investigationId === undefined ? {} : { investigationId: context.investigationId }),
      traceId: context.traceId,
      detail: { ai },
    };
  }

  /** Records the event, or throws the one error that says it could not be: whatever the detail or the sink did, nothing of the call leaves with it. */
  async function record(request: ModelRequest, context: AuditedCallContext, prompt: PromptRecord, outcome: Outcome): Promise<void> {
    try {
      await sink.record(eventOf(request, context, prompt, outcome));
    } catch {
      throw new AuditUnavailableError();
    }
  }

  async function call(request: ModelRequest, context: AuditedCallContext, signal: AbortSignal): Promise<ModelAnswer> {
    const resolved = configuration.registry.resolve(request.promptId, request.parameters);
    const failed: Outcome = { result: 'failed', modelRef: configuration.model, usage: UNKNOWN_USAGE };
    let answer: ModelAnswer;
    try {
      answer = await provider.complete(request, signal);
    } catch (error) {
      await record(request, context, resolved.record, failed);
      throw error;
    }
    if (!sameRecord(answer.prompt, resolved.record)) {
      await record(request, context, resolved.record, failed);
      throw new AuditUnavailableError();
    }
    switch (answer.status) {
      case 'ok':
        await record(request, context, resolved.record, { result: 'success', modelRef: answer.model, usage: answer.usage });
        return answer;
      case 'refused':
        await record(request, context, resolved.record, { result: 'refused', modelRef: configuration.model, usage: answer.usage });
        return answer;
      case 'failed':
        await record(request, context, resolved.record, failed);
        return answer;
      default: {
        const unreachable: never = answer;
        return unreachable;
      }
    }
  }

  return { call, asProvider: (context) => ({ complete: (request, signal) => call(request, context, signal) }) };
}
