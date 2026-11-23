import { ASSISTANT_REFUSAL_SENTENCES, assistantTurnAnswerSchema, ExtensionRefusal, readViewKeys, listsOfBlocks, sentencesOfBlocks, type AssistantTurnAnswer, type ExtensionRequest } from '@neburyx/contracts';
import { AuditUnavailableError } from '@neburyx/ee-ai-runtime';
import { stepsOf } from './steps.js';
import type { ViewInput, ViewOutcome, ViewProgress } from './view-answer.js';

export const OVERVIEW_PROMPT_ID = 'assistant.overview';
export const OVERVIEW_PROMPT_VERSION = 3;
export const OVERVIEW_AUDIT_ACTION = 'assistant.overview';

/** What the overview call is asked, written by the server: the analyst's message is not part of it. */
export const OVERVIEW_REQUEST = 'Describe only what the elements in view are connected by: the relationships between them and what they share. State no property of an element and nothing about what is missing. Group alike connections into a few sentences. Make no assessment.';

export interface VerdictOverviewInput {
  readonly overview: ((input: ViewInput) => Promise<ViewOutcome>) | undefined;
  readonly request: ExtensionRequest;
  readonly body: { readonly sourceId: string; readonly investigationId: string; readonly mask?: boolean | undefined; readonly viewElementKeys: readonly string[] };
  readonly readElements: ExtensionRequest['readElements'];
  readonly deadline: AbortSignal;
  readonly startedAt: number;
  /** The model calls the turn has made, the router's among them. */
  readonly callsUsed: number;
}

const plain = (): AssistantTurnAnswer => ({ status: 'answered', route: 'refuse', cause: 'verdict', sentence: ASSISTANT_REFUSAL_SENTENCES.verdict });

/**
 * The answer to a message the router refused as a request for a verdict: the fixed refusal, and beside it a neutral, cited overview of the elements in view when one can be drawn. The overview is drafted by the view's own path (the elements read again
 * through the gate with the request's masking, the same checks) under a prompt of its own and a request the server wrote, so nothing the analyst typed reaches the call. When it cannot be drawn, for whatever reason, the answer is the plain refusal and says
 * nothing of the attempt; only a cancel, an audit that cannot be recorded and an error that is not the gate's refusal of the read end the turn otherwise, as they do on the view path.
 */
export async function verdictRefusal(input: VerdictOverviewInput): Promise<AssistantTurnAnswer> {
  const { overview, request, body, readElements } = input;
  if (overview === undefined || readElements === undefined) return plain();
  if (request.principalRole !== 'administrator' && request.principalRole !== 'investigator') return plain();
  if (!readViewKeys(body.viewElementKeys, body.sourceId).ok || body.viewElementKeys.length === 0) return plain();
  const progress: ViewProgress = { calls: 0, read: 0, readStarted: false };
  let outcome: ViewOutcome;
  try {
    outcome = await overview({
      onReading: () => stepsOf(request).readingView(),
      onAnswering: () => stepsOf(request).answering(),
      sourceId: body.sourceId,
      investigationId: body.investigationId,
      mask: body.mask === true,
      message: OVERVIEW_REQUEST,
      viewElementKeys: body.viewElementKeys,
      actorId: request.principalId,
      actorRole: request.principalRole,
      traceId: request.traceId,
      readElements,
      signal: request.signal,
      deadline: input.deadline,
      callsUsed: input.callsUsed,
      startedAt: input.startedAt,
      progress,
    });
  } catch (error) {
    if (error instanceof AuditUnavailableError) throw new ExtensionRefusal({ code: 'AUDIT_UNAVAILABLE' });
    if (request.signal.aborted) throw new Error('the request was cancelled');
    // the gate's own refusal of the read, or the time of the turn spent, leaves the plain refusal; anything else is a failure to be seen, as on the view path
    if (error instanceof ExtensionRefusal || input.deadline.aborted) return plain();
    throw error;
  }
  if (outcome.status === 'cancelled') throw new Error('the request was cancelled');
  if (outcome.status !== 'answered') return plain();
  const { answer } = outcome;
  // a table answer has no sentences: the overview is never asked for one
  const sentences = [...sentencesOfBlocks(answer.blocks), ...listsOfBlocks(answer.blocks).flatMap((list) => list.items)];
  if (sentences.length === 0) return plain();
  const citations = answer.citations.flatMap((citation) => (citation.kind === 'description' || citation.kind === 'read' ? [] : [citation]));
  const drawn = { ...plain(), overview: { sentences: [...sentences], citations, coverage: { retrieval: answer.coverage.retrieval, summary: answer.coverage.summary }, model: answer.model } };
  const checked = assistantTurnAnswerSchema.safeParse(drawn);
  return checked.success ? checked.data : plain();
}
