import { AsyncLocalStorage } from 'node:async_hooks';
import {
  ExtensionRefusal,
  assistantTurnAuditDetailSchema,
  isTokenCount,
  tokenCount,
  type AssistantTurnAnswer,
  type AssistantTurnAuditDetail,
  type AssistantThreadTurnWrite,
  type AuditEvent,
  type AuditResult,
  type ExtensionLogger,
  type ExtensionRequest,
} from '@neburyx/contracts';
import type { ModelAnswer } from '@neburyx/ee-ai-runtime';
import { createTurnRun, type CallRecord, type TurnRun, type TurnRunDeps } from './turn-run.js';
import { openTurnThread, type TurnThread, type TurnThreadDeps } from './turn-thread.js';

export const TURN_CLOSED_ACTION = 'assistant.turn.closed';
const TURN_EVENT_NOT_BUILT = 'assistant-turn-event-not-built';

type Route = NonNullable<AssistantTurnAuditDetail['route']>;
type Usage = { readonly kind: 'known'; readonly inputTokens: number; readonly outputTokens: number } | { readonly kind: 'unknown' };

/** What a turn knows as it runs: ids, codes, hashes and counts, never a message, a reply or a value. */
interface TurnNotes {
  /** Opens the turn's run when the turn passes its first checks. */
  readonly open: (started: { readonly sourceId: string; readonly investigationId: string }) => TurnRun;
  readonly openThread: (started: { readonly investigationId: string }) => Promise<TurnThread | undefined>;
  run?: TurnRun;
  thread?: TurnThread;
  questionHash?: string;
  entities?: AssistantThreadTurnWrite['entities'];
  citedRefs?: AssistantThreadTurnWrite['citationRefs'];
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
  /** The things the accepted answer cited, which the thread keeps as references; their number is `citedElements` unless that is given. */
  readonly citedRefs?: AssistantThreadTurnWrite['citationRefs'];
  readonly cause?: string;
}

/** Notes what the route of a turn knows; outside a turn it does nothing. */
export function noteTurn(change: TurnNote): void {
  note((notes) => {
    if (change.route !== undefined) notes.route = change.route;
    if (change.answered !== undefined) notes.answered = change.answered;
    if (change.citedRefs !== undefined) {
      notes.citedRefs = change.citedRefs;
      notes.citedElements ??= change.citedRefs.length;
    }
    if (change.citedElements !== undefined) notes.citedElements = change.citedElements;
    if (change.cause !== undefined) notes.cause = change.cause;
  });
}

/** The turn passed the checks that come before it: from here on it ends in a closing event, and the investigation's epoch is read before the turn does any other work. `questionHash` is the keyed hash of the message, for the thread. */
export const noteTurnStarted = async (started: { readonly sourceId: string; readonly investigationId: string; readonly questionHash?: string }): Promise<void> => {
  const notes = scope.getStore();
  if (notes === undefined) return;
  notes.started = { sourceId: started.sourceId, investigationId: started.investigationId };
  notes.steps = 0;
  notes.run = notes.open(notes.started);
  if (started.questionHash !== undefined) notes.questionHash = started.questionHash;
  notes.thread = await notes.openThread(notes.started);
};

/** The id of the run of the turn that is running, for the events it writes; absent outside a turn and before the turn started. */
export const currentRunId = (): string | undefined => scope.getStore()?.run?.id;

const NO_CALL_RECORD: CallRecord = { received: () => undefined, end: () => undefined };

/** What a model call of the turn is known by; the run id is absent outside a turn. */
export interface ModelCallNote {
  readonly runId?: string;
  /** For the context of the audited call: keeps what the provider returned the moment it returns. */
  readonly received: (answer: ModelAnswer) => void;
  readonly end: CallRecord['end'];
}

/** A model call is about to be made: its prompt and the configured model, which stay if the call throws or is aborted, and its record, written before the call and ended after it. */
export function startModelCall(call: { readonly modelRef: string; readonly promptId: string; readonly promptVersion: number; readonly instructionsSha256: string; readonly instructions: string; readonly values: string }): ModelCallNote {
  const notes = scope.getStore();
  if (notes === undefined) return { received: NO_CALL_RECORD.received, end: NO_CALL_RECORD.end };
  notes.calls += 1;
  notes.modelRef = call.modelRef;
  notes.promptId = call.promptId;
  notes.promptVersion = String(call.promptVersion);
  notes.instructionsSha256 = call.instructionsSha256;
  const record = notes.run?.startCall({ instructionsSha256: call.instructionsSha256, instructions: call.instructions, values: call.values }) ?? NO_CALL_RECORD;
  return { ...(notes.run === undefined ? {} : { runId: notes.run.id }), received: record.received, end: record.end };
}

/** The provider's answer arrived: the model that answered, when it said so, and the usage. */
export const noteModelAnswer = (answer: { readonly model?: string; readonly usage?: Usage }): void =>
  note((notes) => {
    if (answer.model !== undefined) notes.modelRef = answer.model;
    notes.usage = answer.usage ?? { kind: 'unknown' };
  });

/** An intent is about to run: the template, if it has one, the keyed hash of its parameters, the one read it makes and the route it was on. */
export const noteRun = (run: { readonly intent: string; readonly templateId?: TurnNotes['templateId']; readonly paramsHash: string; readonly entities?: AssistantThreadTurnWrite['entities'] }): void =>
  note((notes) => {
    notes.intent = run.intent;
    if (run.templateId !== undefined) notes.templateId = run.templateId;
    notes.paramsHash = run.paramsHash;
    if (run.entities !== undefined) notes.entities = run.entities;
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
    ...(notes.run === undefined ? {} : { runId: notes.run.id }),
    ...call,
  });
}

function closingEvent(request: ExtensionRequest, started: NonNullable<TurnNotes['started']>, result: AuditResult, turn: AssistantTurnAuditDetail): AuditEvent {
  return { actorId: request.principalId, actorRole: request.principalRole, action: TURN_CLOSED_ACTION, result, sourceId: started.sourceId, investigationId: started.investigationId, traceId: request.traceId, detail: { turn } };
}

function endingFor(request: ExtensionRequest, notes: TurnNotes, outcome: { readonly answer: AssistantTurnAnswer } | { readonly error: unknown }): Ending {
  const ending: Ending = 'answer' in outcome ? endingOf(notes, outcome.answer) : endingOfError(outcome.error);
  return request.signal.aborted ? { ...ending, outcome: 'cancelled', result: 'failed' } : ending;
}

/** The things an accepted Ask answer cited, as references: the element or relationship of each citation of its summary. */
function citationRefsOf(notes: TurnNotes, outcome: { readonly answer: AssistantTurnAnswer } | { readonly error: unknown }): AssistantThreadTurnWrite['citationRefs'] {
  if (notes.citedRefs !== undefined) return notes.citedRefs;
  if (!('answer' in outcome) || outcome.answer.status !== 'answered' || outcome.answer.route !== 'ask' || !('answered' in outcome.answer.answer)) return [];
  return outcome.answer.answer.answered.summary?.citations.map((citation) => citation.element) ?? [];
}

/** A turn that ended answered or refused on a route is kept in the thread as references and metadata; a turn that failed, was cancelled or was not let through leaves nothing. */
function storeThread(notes: TurnNotes, ending: Ending, outcome: { readonly answer: AssistantTurnAnswer } | { readonly error: unknown }): void {
  const route = ending.route ?? notes.route;
  if (notes.thread === undefined || route === undefined || (ending.outcome !== 'answered' && ending.outcome !== 'refused')) return;
  const known = notes.usage?.kind === 'known' ? notes.usage : undefined;
  const intent = ending.intent ?? notes.intent;
  notes.thread.write({
    route,
    outcome: ending.outcome,
    ...(ending.cause === undefined ? {} : { cause: ending.cause }),
    questionHash: notes.questionHash ?? '',
    ...(intent === undefined ? {} : { intent }),
    ...(notes.templateId === undefined ? {} : { templateId: notes.templateId }),
    entities: notes.entities ?? [],
    citationRefs: citationRefsOf(notes, outcome),
    steps: notes.steps ?? 0,
    ...(notes.calls === 0 || notes.modelRef === undefined ? {} : { modelRef: notes.modelRef }),
    ...(notes.calls === 0 || notes.promptVersion === undefined ? {} : { promptVersion: notes.promptVersion }),
    ...(known === undefined || notes.calls === 0 ? {} : { tokensIn: known.inputTokens, tokensOut: known.outputTokens }),
    ...(notes.run === undefined ? {} : { runId: notes.run.id }),
  });
}

function close(request: ExtensionRequest, logger: ExtensionLogger | undefined, notes: TurnNotes, outcome: { readonly answer: AssistantTurnAnswer } | { readonly error: unknown }): void {
  const { started } = notes;
  if (started === undefined) return;
  let ending: Ending | undefined;
  try {
    ending = endingFor(request, notes, outcome);
  } catch {
    ending = undefined;
  }
  // the run row ends with the turn's outcome before the closing event says it
  notes.run?.finish(ending?.outcome ?? 'failed', notes.calls);
  if (ending !== undefined) storeThread(notes, ending, outcome);
  let event: AuditEvent;
  try {
    if (ending === undefined) throw new Error('the turn has no ending');
    // a detail the contract does not accept (a free string, a bad count) throws here: it is never queued
    event = closingEvent(request, started, ending.result, detailOf(notes, ending));
  } catch {
    // an event that cannot be built is counted as failed and logged by its ids where the application can, and never changes the turn's answer
    try {
      if (request.audit.failed === undefined) logger?.warn({ event: TURN_EVENT_NOT_BUILT, action: TURN_CLOSED_ACTION, traceId: request.traceId }, 'the closing event of an assistant turn could not be built');
      else request.audit.failed({ actorId: request.principalId, actorRole: request.principalRole, action: TURN_CLOSED_ACTION, result: 'failed', sourceId: started.sourceId, investigationId: started.investigationId, traceId: request.traceId });
    } catch {
      // a logger or a counter that fails changes nothing
    }
    return;
  }
  // the application queues the event and counts and logs its own failures; the turn does not wait for it
  void Promise.resolve()
    .then(() => request.audit.record(event))
    .catch(() => undefined);
}

export interface TurnAuditOptions {
  readonly logger: () => ExtensionLogger | undefined;
  readonly runs?: TurnRunDeps['runs'];
  readonly settings?: TurnRunDeps['settings'];
  readonly now?: () => number;
  readonly threads?: TurnThreadDeps['threads'];
  readonly records?: TurnThreadDeps['queue'];
}

/** Wraps the handler of a turn: one closing event when the turn that passed its first checks ends, whatever the end. The handler's answer or failure goes on as it was. */
export function withTurnAudit(options: TurnAuditOptions, handler: (request: ExtensionRequest) => Promise<AssistantTurnAnswer>): (request: ExtensionRequest) => Promise<AssistantTurnAnswer> {
  const runDeps: TurnRunDeps = { runs: options.runs ?? (() => undefined), settings: options.settings ?? (() => undefined), now: options.now ?? Date.now, logger: options.logger };
  const threadDeps: TurnThreadDeps = { threads: options.threads ?? (() => undefined), queue: options.records ?? (() => undefined), now: options.now ?? Date.now, logger: options.logger };
  return async (request) => {
    const notes: TurnNotes = { calls: 0, open: (started) => createTurnRun(runDeps, request, started), openThread: (started) => openTurnThread(threadDeps, request, started) };
    let answer: AssistantTurnAnswer;
    try {
      answer = await scope.run(notes, () => handler(request));
    } catch (error) {
      close(request, options.logger(), notes, { error });
      throw error;
    }
    close(request, options.logger(), notes, { answer });
    return answer;
  };
}
