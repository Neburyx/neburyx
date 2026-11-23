import { AsyncLocalStorage } from 'node:async_hooks';
import {
  ExtensionRefusal,
  assistantTurnAuditDetailSchema,
  isTokenCount,
  listsOfBlocks,
  tablesOfBlocks,
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
import type { AssistantContextTurn } from './thread-store.js';
import { bindingsApproved, storedAnswerOf } from './thread-answer.js';
import { classifyItem, type ClassifyContext, type Provenance } from './sensitive-items.js';
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
  /** The question as typed, for a turn that carries one, and whether the request asked for the mask: for the thread only. */
  question?: string;
  maskOn?: boolean;
  entities?: AssistantThreadTurnWrite['entities'];
  citedRefs?: AssistantThreadTurnWrite['citationRefs'];
  started?: { readonly sourceId: string; readonly investigationId: string };
  calls: number;
  /** The model calls an application tool made outside the turn's own recording (the AI case summary's), counted in the turn's calls and in no other field of it. */
  summaryCalls?: number;
  /** Whether any text a model call of the turn was given held the value of a property of an element. */
  propertyValuesSent?: boolean;
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
  selectedElements?: number;
  cause?: string;
  summary?: { readonly kept: number; readonly dropped: number };
  tableRowsLeftOut?: number;
  listItemsDropped?: number;
  /** That the reads being made are made again after a decision; and the record of the waiting turn this turn goes on from. */
  replaying?: boolean;
  resumes?: string;
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
  /** How many elements the person selected that the turn kept; a count and nothing of them. */
  readonly selectedElements?: number;
  /** The things the accepted answer cited, which the thread keeps as references; their number is `citedElements` unless that is given. */
  readonly citedRefs?: AssistantThreadTurnWrite['citationRefs'];
  readonly cause?: string;
  /** How many sentences of an attached summary still held and how many did not. */
  readonly summary?: { readonly kept: number; readonly dropped: number };
  /** How many rows of tables the answer left out whole (no table of it is shown), counted as dropped rows in the closing event. */
  readonly tableRowsLeftOut?: number;
  /** How many items of lists the checks removed or the total of 12 cut: a count and nothing of them. */
  readonly listItemsDropped?: number;
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
    if (change.selectedElements !== undefined) notes.selectedElements = change.selectedElements;
    if (change.cause !== undefined) notes.cause = change.cause;
    if (change.summary !== undefined) notes.summary = change.summary;
    if (change.tableRowsLeftOut !== undefined) notes.tableRowsLeftOut = change.tableRowsLeftOut;
    if (change.listItemsDropped !== undefined) notes.listItemsDropped = change.listItemsDropped;
  });
}

/** The turn passed the checks that come before it: from here on it ends in a closing event, and the investigation's epoch is read before the turn does any other work. `questionHash` is the keyed hash of the message, for the thread. */
/** What the classifier reads of the text an answer was written from: the values sent for every element, every element key, the type of each. Kept with the answer object itself, so that the answer a turn ends with is classified against the text it was checked against and never another attempt's. */
const PROVENANCE = new WeakMap<object, Provenance>();
/** The provenance of an answer carried to its copy, when a later step copies it (the follow-ups added to an answer): the copy is the answer the turn ends with. */
export const carryProvenance = <T extends AssistantTurnAnswer>(from: AssistantTurnAnswer, copy: T): T => {
  const held = PROVENANCE.get(from);
  if (held !== undefined) PROVENANCE.set(copy, held);
  return copy;
};
export const stampProvenance = <T extends AssistantTurnAnswer>(answer: T, provenance: Provenance): T => {
  PROVENANCE.set(answer, provenance);
  return answer;
};

export const noteTurnStarted = async (started: { readonly sourceId: string; readonly investigationId: string; readonly questionHash?: string; readonly question?: string; readonly maskOn?: boolean }): Promise<void> => {
  const notes = scope.getStore();
  if (notes === undefined) return;
  notes.started = { sourceId: started.sourceId, investigationId: started.investigationId };
  notes.steps = 0;
  notes.run = notes.open(notes.started);
  if (started.questionHash !== undefined) notes.questionHash = started.questionHash;
  if (started.question !== undefined) notes.question = started.question;
  notes.maskOn = started.maskOn === true;
  notes.thread = await notes.openThread(notes.started);
};

/** The caller's last `limit` turns of the thread of the turn that is running; none outside a turn, before the turn started or when the thread cannot be read. */
export const readTurnContext = async (limit: number): Promise<readonly AssistantContextTurn[]> => (await scope.getStore()?.thread?.context(limit)) ?? [];

/** The id of the run of the turn that is running, for the events it writes; absent outside a turn and before the turn started. */
export const currentRunId = (): string | undefined => scope.getStore()?.run?.id;

/** Notes the model calls of an AI case summary drafted in this turn: the closing event counts them in the turn's calls; its model, prompt and token fields hold only the calls the turn made through its own recording. */
export const noteSummaryCalls = (calls: number): void => note((notes) => void (notes.summaryCalls = (notes.summaryCalls ?? 0) + calls));

/** Notes that the text of a model call of this turn is about to be sent, and whether it holds the value of a property (`AssembledText.carriesPropertyValues`): the closing event says whether any did, and never what a value was. */
export const notePropertyValuesSent = (carries: boolean): void => note((notes) => void (notes.propertyValuesSent = notes.propertyValuesSent === true || carries));

/** Marks the reads that follow as made again to carry on a turn after the analyst's decision (their events say so), or no longer. */
export const noteReplaying = (replaying: boolean): void => note((notes) => void (notes.replaying = replaying));
export const isReplaying = (): boolean => scope.getStore()?.replaying === true;

/** Notes the record of the waiting turn this turn goes on from. */
export const noteResumes = (runId: string): void => note((notes) => void (notes.resumes = runId));

const NO_CALL_RECORD: CallRecord = { received: () => undefined, end: () => undefined };

/** What a model call of the turn is known by; the run id is absent outside a turn. */
export interface ModelCallNote {
  readonly runId?: string;
  /** For the context of the audited call: keeps what the provider returned the moment it returns. */
  readonly received: (answer: ModelAnswer) => void;
  readonly end: CallRecord['end'];
}

/** A model call is about to be made: its prompt and the configured model, which stay if the call throws or is aborted, and its record, written before the call and ended after it. */
export function startModelCall(call: { readonly modelRef: string; readonly promptId: string; readonly promptVersion: number; readonly instructionsSha256: string; readonly instructions: string; readonly values: string; readonly tools?: readonly string[] }): ModelCallNote {
  const notes = scope.getStore();
  if (notes === undefined) return { received: NO_CALL_RECORD.received, end: NO_CALL_RECORD.end };
  notes.calls += 1;
  notes.modelRef = call.modelRef;
  notes.promptId = call.promptId;
  notes.promptVersion = String(call.promptVersion);
  notes.instructionsSha256 = call.instructionsSha256;
  delete notes.usage;
  const record = notes.run?.startCall({ instructionsSha256: call.instructionsSha256, instructions: call.instructions, values: call.values, ...(call.tools === undefined ? {} : { tools: call.tools }) }) ?? NO_CALL_RECORD;
  return { ...(notes.run === undefined ? {} : { runId: notes.run.id }), received: record.received, end: record.end };
}

/** The provider's answer arrived: the model that answered, when it said so, and the usage. */
export const noteModelAnswer = (answer: { readonly model?: string; readonly usage?: Usage }): void =>
  note((notes) => {
    if (answer.model !== undefined) notes.modelRef = answer.model;
    notes.usage = answer.usage ?? { kind: 'unknown' };
  });

/** An intent is about to run: the first one of a turn gives the turn its intent, template and keyed hash of parameters; every one adds the elements its parameters resolved to and counts as a step. */
export const noteRun = (run: { readonly intent: string; readonly templateId?: TurnNotes['templateId']; readonly paramsHash: string; readonly entities?: AssistantThreadTurnWrite['entities'] }): void =>
  note((notes) => {
    if (notes.intent === undefined) {
      notes.intent = run.intent;
      if (run.templateId !== undefined) notes.templateId = run.templateId;
      notes.paramsHash = run.paramsHash;
    }
    if (run.entities !== undefined) notes.entities = [...(notes.entities ?? []), ...run.entities];
    notes.steps = (notes.steps ?? 0) + 1;
    notes.route ??= 'ask';
  });

/** A step that is not an intent (the view read again) ran: it counts as a step of the turn. */
export const noteStep = (): void =>
  note((notes) => {
    notes.steps = (notes.steps ?? 0) + 1;
    notes.route ??= 'ask';
  });

const codeOf = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'unknown';

interface Ending {
  readonly route?: Route;
  readonly outcome: AssistantTurnAuditDetail['outcome'];
  readonly result: AuditResult;
  readonly cause?: string;
  readonly valueKind?: 'other-type' | 'not-found' | 'hidden';
  readonly failureKind?: string;
  readonly intent?: string;
  readonly citedElements?: number;
  readonly table?: { readonly shown: number; readonly dropped?: number; readonly notShown?: number };
  readonly list?: { readonly shown: number; readonly dropped?: number };
}

const tableOf = (tables: readonly { readonly rows: readonly unknown[]; readonly droppedRows?: number; readonly moreNotShown?: number }[], leftOut: number): NonNullable<Ending['table']> => {
  const dropped = tables.reduce((sum, table) => sum + (table.droppedRows ?? 0), leftOut);
  const notShown = tables.reduce((sum, table) => sum + (table.moreNotShown ?? 0), 0);
  return { shown: tables.reduce((sum, table) => sum + table.rows.length, 0), ...(dropped === 0 ? {} : { dropped }), ...(notShown === 0 ? {} : { notShown }) };
};

function endingOf(notes: TurnNotes, answer: AssistantTurnAnswer): Ending {
  switch (answer.status) {
    case 'answered':
      if (answer.route === 'refuse') return { route: 'refuse', outcome: 'refused', result: 'refused', cause: answer.cause, ...(answer.overview === undefined ? {} : { citedElements: answer.overview.citations.length }) };
      if ('blocks' in answer) {
        const tables = tablesOfBlocks(answer.blocks);
        const lists = listsOfBlocks(answer.blocks);
        const listDropped = notes.listItemsDropped ?? 0;
        return { route: answer.route, outcome: 'answered', result: 'success', citedElements: answer.citations.length, ...(tables.length === 0 && (notes.tableRowsLeftOut ?? 0) === 0 ? {} : { table: tableOf(tables, notes.tableRowsLeftOut ?? 0) }), ...(lists.length === 0 && listDropped === 0 ? {} : { list: { shown: lists.reduce((sum, list) => sum + list.items.length, 0), ...(listDropped === 0 ? {} : { dropped: listDropped }) } }), ...('stoppedAt' in answer && answer.stoppedAt !== undefined ? { cause: `limit-${answer.stoppedAt}` } : {}) };
      }
      if ('refused' in answer.answer) return { route: 'ask', outcome: 'refused', result: 'refused', cause: answer.answer.refused.cause, ...(answer.answer.refused.valueNotFit === undefined ? {} : { valueKind: answer.answer.refused.valueNotFit.kind }), ...(answer.answer.refused.intent === undefined ? {} : { intent: answer.answer.refused.intent }) };
      return {
        route: 'ask',
        outcome: 'answered',
        result: answer.answer.answered.outcome === 'partial' || answer.answer.answered.continueToken !== undefined ? 'partial' : 'success',
        intent: answer.answer.answered.intent,
        ...(answer.answer.answered.summary === undefined ? {} : { citedElements: answer.answer.answered.summary.citations.length }),
        ...(answer.stoppedAt === undefined ? {} : { cause: `limit-${answer.stoppedAt}` }),
      };
    case 'not-answered':
      if (notes.answered === true) return { route: answer.route, outcome: 'answered', result: 'success', ...(notes.citedElements === undefined ? {} : { citedElements: notes.citedElements }) };
      return { route: answer.route, outcome: 'refused', result: 'refused', cause: notes.cause ?? 'not-answered' };
    case 'meaning':
      return { route: 'view', outcome: 'answered', result: 'success', cause: 'meaning' };
    case 'no-description':
      return { route: answer.route, outcome: 'answered', result: 'success', cause: 'no-description' };
    case 'unavailable':
      return { ...(notes.route === 'view' ? { route: 'view' as const } : answer.readStarted ? { route: 'ask' as const } : {}), outcome: 'failed', result: 'failed', failureKind: answer.kind };
    case 'too-large':
      return { outcome: 'refused', result: 'refused', cause: 'too-large' };
    case 'limit':
      return { outcome: 'refused', result: 'refused', cause: `limit-${answer.limit}` };
    case 'too-long':
      return { outcome: 'refused', result: 'refused', cause: 'too-long' };
    case 'continue-invalid':
      return { outcome: 'refused', result: 'refused', cause: 'continue-invalid' };
    case 'clarification':
      return { route: 'ask', outcome: 'clarification', result: 'success' };
    case 'choice-invalid':
      return { outcome: 'refused', result: 'refused', cause: 'choice-invalid' };
    case 'summary-invalid':
      return { outcome: 'refused', result: 'refused', cause: 'summary-invalid' };
    case 'confirmation-invalid':
      return { outcome: 'refused', result: 'refused', cause: 'confirmation-invalid' };
    case 'cancelled':
      return { outcome: 'cancelled', result: 'failed', failureKind: 'cancelled' };
    case 'confirmation':
      return { route: 'ask', outcome: 'confirmation', result: 'success' };
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
    ...(ending.valueKind === undefined ? {} : { valueKind: ending.valueKind }),
    ...(ending.failureKind === undefined ? {} : { failureKind: ending.failureKind }),
    ...(intent === undefined ? {} : { intent }),
    ...(notes.templateId === undefined ? {} : { templateId: notes.templateId }),
    ...(notes.paramsHash === undefined ? {} : { paramsHash: notes.paramsHash }),
    ...(notes.steps === undefined ? {} : { steps: notes.steps }),
    ...(ending.citedElements === undefined ? {} : { citedElements: ending.citedElements }),
    ...(ending.list === undefined ? {} : { listItemsShown: ending.list.shown, ...(ending.list.dropped === undefined ? {} : { listItemsDropped: ending.list.dropped }) }),
    ...(ending.table === undefined ? {} : { form: 'table' as const, tableRowsShown: ending.table.shown, ...(ending.table.dropped === undefined ? {} : { tableRowsDropped: ending.table.dropped }), ...(ending.table.notShown === undefined ? {} : { tableRowsNotShown: ending.table.notShown }) }),
    ...(notes.selectedElements === undefined || notes.selectedElements === 0 ? {} : { selectedElements: notes.selectedElements }),
    ...(notes.summary === undefined ? {} : { summarySentencesKept: notes.summary.kept, summarySentencesDropped: notes.summary.dropped }),
    modelCalls: notes.calls + (notes.summaryCalls ?? 0),
    ...(notes.calls + (notes.summaryCalls ?? 0) > 0 ? { propertyValuesSent: notes.propertyValuesSent === true } : {}),
    ...(notes.run === undefined ? {} : { runId: notes.run.id }),
    ...(notes.resumes === undefined ? {} : { resumes: notes.resumes }),
    ...call,
  });
}

function closingEvent(request: ExtensionRequest, started: NonNullable<TurnNotes['started']>, result: AuditResult, turn: AssistantTurnAuditDetail): AuditEvent {
  return { actorId: request.principalId, actorRole: request.principalRole, action: TURN_CLOSED_ACTION, result, sourceId: started.sourceId, investigationId: started.investigationId, traceId: request.traceId, detail: { turn } };
}

function endingFor(request: ExtensionRequest, notes: TurnNotes, outcome: { readonly answer: AssistantTurnAnswer } | { readonly error: unknown }): Ending {
  const ending: Ending = 'answer' in outcome ? endingOf(notes, outcome.answer) : endingOfError(outcome.error);
  return request.signal.aborted ? { ...ending, outcome: 'cancelled', result: 'failed', failureKind: 'cancelled' } : ending;
}

/** The things an accepted answer cited, as references: the element or relationship of each citation of an answer from the view, or of the summary of an Ask answer. */
function citationRefsOf(notes: TurnNotes, outcome: { readonly answer: AssistantTurnAnswer } | { readonly error: unknown }): AssistantThreadTurnWrite['citationRefs'] {
  if (notes.citedRefs !== undefined) return notes.citedRefs;
  if ('answer' in outcome && outcome.answer.status === 'answered' && 'blocks' in outcome.answer) return outcome.answer.citations.flatMap((citation) => (citation.kind === 'description' || citation.kind === 'read' ? [] : [citation.ref]));
  if (!('answer' in outcome) || outcome.answer.status !== 'answered' || outcome.answer.route !== 'ask' || !('answer' in outcome.answer) || !('answered' in outcome.answer.answer)) return [];
  return outcome.answer.answer.answered.summary?.citations.map((citation) => citation.element) ?? [];
}

/** The text a turn keeps in its thread: the question as typed and the answer in its stored form, for an answered or refused turn only; a waiting turn keeps none, and a turn whose answer has no stored form yet keeps its question alone. */
function textOf(request: ExtensionRequest, notes: TurnNotes, kept: 'answered' | 'refused' | 'waiting', outcome: { readonly answer: AssistantTurnAnswer } | { readonly error: unknown }): Partial<Pick<AssistantThreadTurnWrite, 'question' | 'maskOn' | 'answer' | 'sensitivityVersion'>> | undefined {
  if (kept === 'waiting') return {};
  const maskOn = notes.maskOn === true;
  const sourceId = notes.started?.sourceId;
  // the keys and the version are read from the live mapping one after the other: when the version moved between the reads, the pair is not one snapshot, and neither is used
  const before = sourceId === undefined ? undefined : safely(() => request.sensitivityVersion?.(sourceId));
  const read = sourceId === undefined ? undefined : safely(() => request.sensitiveKeys?.(sourceId));
  const after = sourceId === undefined ? undefined : safely(() => request.sensitivityVersion?.(sourceId));
  const steady = before !== undefined && before === after;
  const keys = steady ? read : undefined;
  const version = steady ? before : undefined;
  const provenance = 'answer' in outcome ? PROVENANCE.get(outcome.answer) : undefined;
  const context: ClassifyContext = { sentValues: provenance?.sentValues, sent: provenance?.sent ?? [], typeOf: provenance?.typeOf ?? (() => undefined), sensitiveKeys: keys };
  const stored = 'answer' in outcome ? storedAnswerOf(outcome.answer, maskOn, (text, cited) => classifyItem(text, cited, context)) : undefined;
  const answer = stored?.answer;
  // a binding to anything the classifier could not have approved refuses the write as a whole: nothing of the turn is stored
  if (stored !== undefined && !maskOn && !bindingsApproved(stored.answer, context, stored.keyOf, sourceId)) return undefined;
  return { ...(notes.question === undefined ? {} : { question: notes.question }), maskOn, ...(answer === undefined ? {} : { answer }), ...(version === undefined ? {} : { sensitivityVersion: version }) };
}

/** Runs a capability of the request: one that throws is as if it were absent. */
function safely<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** A turn that ended answered or refused on a route is kept in the thread as references and metadata; a turn that failed, was cancelled or was not let through leaves nothing. */
function storeThread(request: ExtensionRequest, notes: TurnNotes, ending: Ending, outcome: { readonly answer: AssistantTurnAnswer } | { readonly error: unknown }): void {
  const route = ending.route ?? notes.route;
  const kept = ending.outcome === 'confirmation' ? ('waiting' as const) : ending.outcome === 'answered' || ending.outcome === 'refused' ? ending.outcome : undefined;
  if (notes.thread === undefined || route === undefined || kept === undefined) return;
  // a summary that could not be used leaves nothing in the thread, even when the turn had been placed on a route
  if (ending.cause === 'summary-invalid') return;
  const text = textOf(request, notes, kept, outcome);
  if (text === undefined) {
    notes.thread.refused('binding');
    return;
  }
  const known = notes.usage?.kind === 'known' ? notes.usage : undefined;
  const intent = ending.intent ?? notes.intent;
  notes.thread.write({
    route,
    outcome: kept,
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
    ...text,
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
  notes.run?.finish(ending?.outcome ?? 'failed', notes.calls + (notes.summaryCalls ?? 0));
  if (ending !== undefined) storeThread(request, notes, ending, outcome);
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
