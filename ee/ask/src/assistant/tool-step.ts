import { ASK_SAVED_PATTERN_INTENT, ExtensionRefusal, readViewKeys, type AskAnswer, type SummaryReading } from '@neburyx/contracts';
import { gateClientOf } from '@neburyx/ee-ai-runtime';
import { execute, patternOf, refusal, type Execution } from '../questions/question-routes.js';
import { summarizeRun } from '../questions/run-summary.js';
import { noteStep } from './turn-audit.js';
import type { ToolRequest } from './tool-request.js';
import { withTemplateTools } from './tool-templates.js';

type Answered = Extract<AskAnswer, { answered: unknown }>['answered'];
type Refused = Extract<AskAnswer, { refused: unknown }>['refused'];

/** What one step of the loop is run against: the request, the gate's capabilities and the options of Ask's routes, and the view the person had on screen. */
export type StepScope = Pick<Execution, 'request' | 'capabilities' | 'options' | 'sourceId' | 'mask' | 'investigationId' | 'patterns' | 'action'> & { readonly viewElementKeys: readonly string[]; readonly askedTypes?: readonly string[]; readonly contextTypes?: readonly string[] };

export type StepResult =
  | { readonly status: 'answered'; readonly answer: Answered; readonly rows: number }
  /** A read Ask would stop as heavy: it was not read further, and the answer holds the continue token. */
  | { readonly status: 'heavy'; readonly answer: Answered }
  | { readonly status: 'refused'; readonly refused: Refused }
  | { readonly status: 'view'; readonly reading: SummaryReading; readonly rows: number }
  | { readonly status: 'no-view' };

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
export async function runToolStep(requested: ToolRequest, scope: StepScope, options: { readonly continuing?: boolean } = {}): Promise<StepResult> {
  if (scope.request.signal.aborted) throw new Error('the request was cancelled');
  const { tool, values } = requested;
  if (tool.kind === 'view') return readView(scope);
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
