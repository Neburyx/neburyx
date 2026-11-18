import { AsyncLocalStorage } from 'node:async_hooks';
import {
  ExtensionRefusal,
  assistantTurnAuditDetailSchema,
  isTokenCount,
  tokenCount,
  type AssistantTurnAnswer,
  type AssistantTurnAuditDetail,
  type AuditEvent,
  type AuditResult,
  type ExtensionLogger,
  type ExtensionRequest,
} from '@neburyx/contracts';

export const TURN_CLOSED_ACTION = 'assistant.turn.closed';
const TURN_EVENT_NOT_BUILT = 'assistant-turn-event-not-built';

type Route = NonNullable<AssistantTurnAuditDetail['route']>;
type Usage = { readonly kind: 'known'; readonly inputTokens: number; readonly outputTokens: number } | { readonly kind: 'unknown' };

/** What a turn knows as it runs: ids, codes, hashes and counts, never a message, a reply or a value. */
interface TurnNotes {
  started?: { readonly sourceId: string; readonly investigationId: string };
  calls: number;
  modelRef?: string;
  promptId?: string;
  promptVersion?: string;
  instructionsSha256?: string;
  usage?: Usage;
  intent?: string;
  templateId?: NonNullable<AssistantTurnAuditDetail['templateId']>;
  paramsHash?: string;
  steps?: number;
  route?: Route;
  answered?: boolean;
  citedElements?: number;
  cause?: string;
}

const scope = new AsyncLocalStorage<TurnNotes>();

const note = (change: (notes: TurnNotes) => void): void => {
  const notes = scope.getStore();
  if (notes !== undefined) change(notes);
};

/** What the answer of the turn's route tells the closing event beyond what the turn's answer carries: lane code that answers a turn calls this. `answered` is true for an answer of which the checks kept at least one sentence. */
export interface TurnNote {
  readonly route?: Route;
  readonly answered?: boolean;
  readonly citedElements?: number;
  readonly cause?: string;
}

/** Notes what the route of a turn knows; outside a turn it does nothing. */
export function noteTurn(change: TurnNote): void {
  note((notes) => {
    if (change.route !== undefined) notes.route = change.route;
    if (change.answered !== undefined) notes.answered = change.answered;
    if (change.citedElements !== undefined) notes.citedElements = change.citedElements;
    if (change.cause !== undefined) notes.cause = change.cause;
  });
}

/** The turn passed the checks that come before it: from here on it ends in a closing event. */
export const noteTurnStarted = (started: { readonly sourceId: string; readonly investigationId: string }): void =>
  note((notes) => {
    notes.started = started;
    notes.steps = 0;
  });

/** A model call is about to be made: its prompt and the configured model, which stay if the call throws or is aborted. */
export const noteModelCall = (call: { readonly modelRef: string; readonly promptId: string; readonly promptVersion: number; readonly instructionsSha256: string }): void =>
  note((notes) => {
    notes.calls += 1;
    notes.modelRef = call.modelRef;
    notes.promptId = call.promptId;
    notes.promptVersion = String(call.promptVersion);
    notes.instructionsSha256 = call.instructionsSha256;
  });

/** The provider's answer arrived: the model that answered, when it said so, and the usage. */
export const noteModelAnswer = (answer: { readonly model?: string; readonly usage?: Usage }): void =>
  note((notes) => {
    if (answer.model !== undefined) notes.modelRef = answer.model;
    notes.usage = answer.usage ?? { kind: 'unknown' };
  });

/** An intent is about to run: the template, if it has one, the keyed hash of its parameters, the one read it makes and the route it was on. */
export const noteRun = (run: { readonly intent: string; readonly templateId?: TurnNotes['templateId']; readonly paramsHash: string }): void =>
  note((notes) => {
    notes.intent = run.intent;
    if (run.templateId !== undefined) notes.templateId = run.templateId;
    notes.paramsHash = run.paramsHash;
    notes.steps = 1;
    notes.route = 'ask';
  });

const codeOf = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'unknown';

interface Ending {
  readonly route?: Route;
  readonly outcome: AssistantTurnAuditDetail['outcome'];
  readonly result: AuditResult;
  readonly cause?: string;
  readonly failureKind?: string;
  readonly intent?: string;
  readonly citedElements?: number;
}

function endingOf(notes: TurnNotes, answer: AssistantTurnAnswer): Ending {
  switch (answer.status) {
    case 'answered':
      if (answer.route === 'refuse') return { route: 'refuse', outcome: 'refused', result: 'refused', cause: answer.cause };
      if ('refused' in answer.answer) return { route: 'ask', outcome: 'refused', result: 'refused', cause: answer.answer.refused.cause, ...(answer.answer.refused.intent === undefined ? {} : { intent: answer.answer.refused.intent }) };
      return {
        route: 'ask',
        outcome: 'answered',
        result: answer.answer.answered.outcome === 'partial' || answer.answer.answered.continueToken !== undefined ? 'partial' : 'success',
        intent: answer.answer.answered.intent,
        ...(answer.answer.answered.summary === undefined ? {} : { citedElements: answer.answer.answered.summary.citations.length }),
      };
    case 'not-answered':
      if (notes.answered === true) return { route: 'view', outcome: 'answered', result: 'success', ...(notes.citedElements === undefined ? {} : { citedElements: notes.citedElements }) };
      return { route: 'view', outcome: 'refused', result: 'refused', cause: notes.cause ?? 'not-answered' };
    case 'unavailable':
      return { ...(answer.readStarted ? { route: 'ask' as const } : {}), outcome: 'failed', result: 'failed', failureKind: answer.kind };
    case 'too-large':
      return { outcome: 'refused', result: 'refused', cause: 'too-large' };
    case 'too-long':
      return { outcome: 'refused', result: 'refused', cause: 'too-long' };
    case 'continue-invalid':
      return { outcome: 'refused', result: 'refused', cause: 'continue-invalid' };
    default: {
      const unreachable: never = answer;
      return unreachable;
    }
  }
}

const endingOfError = (error: unknown): Ending => ({
  outcome: 'failed',
  result: 'failed',
  failureKind: error instanceof ExtensionRefusal ? codeOf(error.code) : 'internal',
});

function detailOf(notes: TurnNotes, ending: Ending): AssistantTurnAuditDetail {
  const route = ending.route ?? notes.route;
  const intent = ending.intent ?? notes.intent;
  const known = notes.usage?.kind === 'known' ? notes.usage : undefined;
  const count = (value: number | undefined): 'unknown' | ReturnType<typeof tokenCount> => (value !== undefined && isTokenCount(value) ? tokenCount(value) : 'unknown');
  const call =
    notes.calls === 0
      ? {}
      : {
          ...(notes.modelRef === undefined ? {} : { modelRef: notes.modelRef }),
          ...(notes.promptId === undefined ? {} : { promptId: notes.promptId }),
          ...(notes.promptVersion === undefined ? {} : { promptVersion: notes.promptVersion }),
          ...(notes.instructionsSha256 === undefined ? {} : { instructionsSha256: notes.instructionsSha256 }),
          tokensIn: count(known?.inputTokens),
          tokensOut: count(known?.outputTokens),
        };
  return assistantTurnAuditDetailSchema.parse({
    ...(route === undefined ? {} : { route }),
    outcome: ending.outcome,
    ...(ending.cause === undefined ? {} : { cause: ending.cause }),
    ...(ending.failureKind === undefined ? {} : { failureKind: ending.failureKind }),
    ...(intent === undefined ? {} : { intent }),
    ...(notes.templateId === undefined ? {} : { templateId: notes.templateId }),
    ...(notes.paramsHash === undefined ? {} : { paramsHash: notes.paramsHash }),
    ...(notes.steps === undefined ? {} : { steps: notes.steps }),
    ...(ending.citedElements === undefined ? {} : { citedElements: ending.citedElements }),
    modelCalls: notes.calls,
    ...call,
  });
}

function closingEvent(request: ExtensionRequest, started: NonNullable<TurnNotes['started']>, result: AuditResult, turn: AssistantTurnAuditDetail): AuditEvent {
  return { actorId: request.principalId, actorRole: request.principalRole, action: TURN_CLOSED_ACTION, result, sourceId: started.sourceId, investigationId: started.investigationId, traceId: request.traceId, detail: { turn } };
}

function close(request: ExtensionRequest, logger: ExtensionLogger | undefined, notes: TurnNotes, outcome: { readonly answer: AssistantTurnAnswer } | { readonly error: unknown }): void {
  const { started } = notes;
  if (started === undefined) return;
  let event: AuditEvent;
  try {
    let ending: Ending = 'answer' in outcome ? endingOf(notes, outcome.answer) : endingOfError(outcome.error);
    if (request.signal.aborted) ending = { ...ending, outcome: 'cancelled', result: 'failed' };
    // a detail the contract does not accept (a free string, a bad count) throws here: it is logged by the ids of the turn and never queued
    event = closingEvent(request, started, ending.result, detailOf(notes, ending));
  } catch {
    // an event that cannot be built is logged by its ids and never changes the turn's answer
    try {
      logger?.warn({ event: TURN_EVENT_NOT_BUILT, action: TURN_CLOSED_ACTION, traceId: request.traceId }, 'the closing event of an assistant turn could not be built');
    } catch {
      // a logger that fails changes nothing
    }
    return;
  }
  // the application queues the event and counts and logs its own failures; the turn does not wait for it
  void Promise.resolve()
    .then(() => request.audit.record(event))
    .catch(() => undefined);
}

/** Wraps the handler of a turn: one closing event when the turn that passed its first checks ends, whatever the end. The handler's answer or failure goes on as it was. */
export function withTurnAudit(logger: () => ExtensionLogger | undefined, handler: (request: ExtensionRequest) => Promise<AssistantTurnAnswer>): (request: ExtensionRequest) => Promise<AssistantTurnAnswer> {
  return async (request) => {
    const notes: TurnNotes = { calls: 0 };
    let answer: AssistantTurnAnswer;
    try {
      answer = await scope.run(notes, () => handler(request));
    } catch (error) {
      close(request, logger(), notes, { error });
      throw error;
    }
    close(request, logger(), notes, { answer });
    return answer;
  };
}
