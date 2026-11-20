import { ASK_SAVED_PATTERN_INTENT, ExtensionRefusal, SUMMARY_DEFAULTS, readViewKeys, type AskAnswer, type SummaryReading } from '@neburyx/contracts';
import { AuditUnavailableError, gateClientOf } from '@neburyx/ee-ai-runtime';
import { SummaryHandled } from '../case-summary/summarizer.js';
import { canonicalText } from '../questions/canonical.js';
import { endTitle, nodeTitle } from '../summary/title.js';
import { execute, patternOf, refusal, type Execution } from '../questions/question-routes.js';
import { summarizeRun } from '../questions/run-summary.js';
import { rebuildNotesFor } from '../case-summary/notes-read-route.js';
import { noteStep, noteSummaryCalls } from './turn-audit.js';
import type { ToolRequest } from './tool-request.js';
import { withTemplateTools } from './tool-templates.js';

type Answered = Extract<AskAnswer, { answered: unknown }>['answered'];
type Refused = Extract<AskAnswer, { refused: unknown }>['refused'];

/** What one step of the loop is run against: the request, the gate's capabilities and the options of Ask's routes, and the view the person had on screen. */
export type StepScope = Omit<Pick<Execution, 'request' | 'capabilities' | 'options' | 'sourceId' | 'mask' | 'investigationId' | 'patterns' | 'action'>, 'options'> & { readonly options: Execution['options'] & { readonly typology?: () => readonly string[] | undefined; readonly notesMaxRefs?: () => number | undefined }; readonly viewElementKeys: readonly string[]; readonly askedTypes?: readonly string[]; readonly contextTypes?: readonly string[] };

export type StepResult =
  | { readonly status: 'answered'; readonly answer: Answered; readonly rows: number }
  /** A read Ask would stop as heavy: it was not read further, and the answer holds the continue token. */
  | { readonly status: 'heavy'; readonly answer: Answered }
  | { readonly status: 'refused'; readonly refused: Refused }
  | { readonly status: 'view'; readonly reading: SummaryReading; readonly rows: number }
  | { readonly status: 'no-view' }
  /** The lines of the typology: the product's own text, no read of the source. */
  | { readonly status: 'typology'; readonly lines: readonly string[] }
  /** The sentences of the person's own AI notes, rebuilt for them through the gate: each with the elements it rests on, how many entries were not read, and the rows of the gate's read. */
  | { readonly status: 'ai-notes'; readonly sentences: readonly NoteSentence[]; readonly notRead: number; readonly rows: number }
  /** The notes could not be read: there is no investigation or the draft is not the caller's. */
  | { readonly status: 'no-notes' }
  /** The checked sentences of an AI case summary drafted in this turn, with the elements each rests on, the model calls it made and the rows of the gate's read when this step made one (and its reading, to be used again). */
  | { readonly status: 'ai-summary'; readonly sentences: readonly NoteSentence[]; readonly calls: number; readonly rows: number; readonly reading: SummaryReading }
  /** The summary was not drafted: it could not start, or the summarizer gave no sentence; the model calls it made are counted all the same. */
  | { readonly status: 'no-summary'; readonly calls: number };

export interface NoteSentence {
  readonly text: string;
  readonly citations: readonly { readonly kind: 'entity' | 'relationship'; readonly ref: unknown; readonly title: string; readonly type: string }[];
}

async function readView(scope: StepScope): Promise<StepResult> {
  const keys = readViewKeys(scope.viewElementKeys, scope.sourceId);
  const { readElements } = gateClientOf(scope.request);
  if (!keys.ok || readElements === undefined) return { status: 'no-view' };
  const { entities, edges, aggregates, derived } = keys.refs;
  if (entities.length + edges.length + aggregates.length + derived.length === 0) return { status: 'no-view' };
  const reading = await readElements({ investigationId: scope.investigationId ?? '', sourceId: scope.sourceId, mask: scope.mask, signal: scope.request.signal }, keys.refs);
  const rows = reading.nodes.length + reading.edges.length;
  noteStep();
  return rows === 0 ? { status: 'no-view' } : { status: 'view', reading, rows };
}

/** The refusal for a draft that is not the caller's: the application's own error and the extension's refusal both carry the code. */
const isNotFound = (error: unknown): boolean => error instanceof ExtensionRefusal ? error.code === 'NOT_FOUND' : typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'NOT_FOUND';

/** The person's own AI notes through the capability the application gave the turn: the draft of this investigation and no other, rebuilt for this person and this masking. A draft that is not theirs is `NOT_FOUND`, and the step reads as not read. */
async function readNotes(scope: StepScope): Promise<StepResult> {
  const { aiNotes } = scope.request;
  const { readElements } = gateClientOf(scope.request);
  if (aiNotes === undefined || readElements === undefined || scope.investigationId === undefined) return { status: 'no-notes' };
  try {
    const rebuilt = await rebuildNotesFor({ aiNotes, readElements, investigationId: scope.investigationId, sourceId: scope.sourceId, mask: scope.mask, maxRefs: scope.options.notesMaxRefs?.() ?? SUMMARY_DEFAULTS.maxElements, signal: scope.request.signal });
    noteStep();
    const sentences = rebuilt.entries.flatMap((entry) => entry.sentences.map((sentence) => ({ text: sentence.text, citations: sentence.citations })));
    return { status: 'ai-notes', sentences, notRead: rebuilt.skipped.length, rows: rebuilt.reading === undefined ? 0 : rebuilt.reading.nodes.length + rebuilt.reading.edges.length };
  } catch (error) {
    if (isNotFound(error)) return { status: 'no-notes' };
    throw error;
  }
}

/** What a step may be given by the loop: the view's reading the turn already has (an AI case summary is drafted over it and no read is made again), and the model calls the turn can spare for the summary. */
export interface StepOptions {
  readonly continuing?: boolean;
  readonly viewReading?: SummaryReading;
  readonly callsBudget?: number;
  /** The turn's deadline: a summary drafted in the step ends with it. */
  readonly deadline?: AbortSignal;
}

/**
 * The AI case summary of the elements in view, drafted by the product's summarizer in this turn: over the reading the turn already has, or over one read through the gate here (its rows count). The summarizer makes no more calls than the budget the loop gave it, and every call it makes is
 * counted. What it returns is its checked sentences, each with the elements it rests on as the reading shows them; any other outcome is a summary that was not drafted.
 */
async function readSummary(scope: StepScope, options: StepOptions): Promise<StepResult> {
  const { caseSummarizer: summarizer } = scope.request;
  const { readElements } = gateClientOf(scope.request);
  const keys = readViewKeys(scope.viewElementKeys, scope.sourceId);
  const budget = options.callsBudget ?? 0;
  const role = scope.request.principalRole;
  if (role === null || !keys.ok || readElements === undefined || scope.investigationId === undefined || !summarizer.availability().available || budget < 1) return { status: 'no-summary', calls: 0 };
  const { entities, edges, aggregates, derived } = keys.refs;
  if (entities.length + edges.length + aggregates.length + derived.length > summarizer.maxElements) return { status: 'no-summary', calls: 0 };
  let rows = 0;
  let reading = options.viewReading;
  if (reading === undefined) {
    reading = await readElements({ investigationId: scope.investigationId, sourceId: scope.sourceId, mask: scope.mask, signal: scope.request.signal }, keys.refs);
    rows = reading.nodes.length + reading.edges.length;
  }
  noteStep();
  let outcome;
  try {
    outcome = await summarizer.summarize({ actorId: scope.request.principalId, actorRole: role, traceId: scope.request.traceId, policyVersion: scope.request.policyVersion?.(scope.sourceId) ?? 'none', request: { investigationId: scope.investigationId, sourceId: scope.sourceId, mask: scope.mask, entities: [...entities], edges: [...edges], aggregates: [...aggregates], derived: [...derived] }, reading, maxCalls: budget, ...(options.deadline === undefined ? {} : { deadline: options.deadline }) }, scope.request.signal);
  } catch (error) {
    if (error instanceof AuditUnavailableError) throw error;
    if (error instanceof SummaryHandled) {
      noteSummaryCalls(error.calls);
      throw error.handled;
    }
    throw error;
  }
  noteSummaryCalls('calls' in outcome ? outcome.calls : 0);
  if (outcome.status !== 'ok' && outcome.status !== 'partial') return { status: 'no-summary', calls: 'calls' in outcome ? outcome.calls : 0 };
  const nodes = new Map(reading.nodes.map((node) => [canonicalText(node.ref), node]));
  const edgeOf = new Map(reading.edges.map((edge) => [canonicalText(edge.ref), edge]));
  const shown = new Map<string, NoteSentence['citations'][number]>(outcome.citations.flatMap((citation): (readonly [string, NoteSentence['citations'][number]])[] => {
    if (citation.kind === 'entity') {
      const node = nodes.get(canonicalText(citation.ref));
      return node === undefined ? [] : [[citation.key, { kind: 'entity', ref: node.ref, title: nodeTitle(node), type: node.display.type }]];
    }
    const edge = edgeOf.get(canonicalText(citation.ref));
    return edge === undefined ? [] : [[citation.key, { kind: 'relationship', ref: edge.ref, title: `${endTitle(edge.from, nodes)} → ${endTitle(edge.to, nodes)}`, type: edge.type }]];
  }));
  const sentences = outcome.sentences.flatMap((sentence) => {
    const citations = sentence.cites.map((key) => shown.get(key));
    return citations.length === 0 || citations.some((citation) => citation === undefined) ? [] : [{ text: sentence.text, citations: citations.flatMap((citation) => (citation === undefined ? [] : [citation])) }];
  });
  return { status: 'ai-summary', sentences, calls: outcome.calls, rows, reading };
}

function resultOf(answer: AskAnswer): StepResult {
  if ('refused' in answer) return { status: 'refused', refused: answer.refused };
  if (answer.answered.continueToken !== undefined) return { status: 'heavy', answer: answer.answered };
  return { status: 'answered', answer: answer.answered, rows: summarizeRun(answer.answered.result).rowCount };
}

/** Runs a read as Ask runs it. Values the gate finds do not fit what the source can run (an entity type its mapping does not know) are the model's mistake and not the person's: the step answers as refused, nothing was read, and the turn goes on. */
async function run(execution: Execution): Promise<StepResult> {
  try {
    return resultOf(await execute(execution));
  } catch (error) {
    if (error instanceof ExtensionRefusal && error.code === 'ASK_INTENT_INVALID') return resultOf(refusal('invalid-inputs', { intent: execution.intent }));
    throw error;
  }
}

/**
 * Runs one accepted request for a tool through the gate and returns what it read. A folder intent and a saved pattern run exactly as Ask runs them (the same binding, the same gate, the audit event and the
 * deterministic summary); the view is read again as the view route reads it. The values reach the source only as parameters. A refusal of the gate or a failure of the read is thrown for the turn to answer; a turn
 * that was cancelled starts no step.
 */
export async function runToolStep(requested: ToolRequest, scope: StepScope, options: StepOptions = {}): Promise<StepResult> {
  if (scope.request.signal.aborted) throw new Error('the request was cancelled');
  const { tool, values } = requested;
  if (tool.kind === 'view') return readView(scope);
  if (tool.kind === 'ai-notes') return readNotes(scope);
  if (tool.kind === 'ai-summary') return readSummary(scope, options);
  if (tool.kind === 'typology') {
    noteStep();
    return { status: 'typology', lines: scope.options.typology?.() ?? [] };
  }
  const common = { request: scope.request, capabilities: scope.capabilities, options: scope.options, sourceId: scope.sourceId, mask: scope.mask, continuing: options.continuing === true, action: scope.action, ...(scope.investigationId === undefined ? {} : { investigationId: scope.investigationId }) };
  if (tool.kind === 'pattern') {
    const entities = { pattern: tool.name, ...values };
    // the continue of a saved pattern runs the pattern the route found by its id
    const { findPattern } = gateClientOf(scope.request);
    const offer = options.continuing === true && findPattern !== undefined ? await patternOf(findPattern, scope.sourceId, entities) : undefined;
    return run({ ...common, intent: ASK_SAVED_PATTERN_INTENT, entities, ...(scope.patterns === undefined ? {} : { patterns: scope.patterns }), ...(offer === undefined ? {} : { offer }) });
  }
  if (tool.kind === 'template') return run({ ...common, options: { ...scope.options, folder: () => withTemplateTools(scope.options.folder()) }, intent: tool.name, entities: values });
  return run({ ...common, intent: tool.name, entities: values });
}
