import { ASK_TEMPLATE_IDS, hasDuplicateKeys, type AskAnswer, type AskRunResult, type SummaryReading, type AssistantFailureKind, type AssistantLimit } from '@neburyx/contracts';
import { AuditUnavailableError, type AuditedModelCall } from '@neburyx/ee-ai-runtime';
import { estimateTokens, type AssembledText } from '../case-summary/assemble.js';
import { summarizeRun } from '../questions/run-summary.js';
import { buildStepInstructions, STEP_PROMPT_ID, STEP_PROMPT_VERSION } from './step-instructions.js';
import { buildToolRegistry } from './tool-registry.js';
import { decideToolReply, readToolRequest, type ToolRequest } from './tool-request.js';
import type { ReadDone, ToolAnswerInput, ToolAnswerOutcome } from './tool-answer.js';
import { runToolStep, type StepScope } from './tool-step.js';
import { noteModelAnswer, startModelCall } from './turn-audit.js';

const STEP_AUDIT_ACTION = 'assistant.step';
const REPEAT_NOTE = 'Your last reply was not valid. Reply with {"done":true} or one tool request only: start with { and write nothing before or after it, no reasoning.';
const TEMPLATES: readonly string[] = ASK_TEMPLATE_IDS;

/** The tools a turn may ask for in this scope: the source's intents, the catalog templates, the person's patterns and, when it can be read again, the view. */
export const toolRegistryOf = (scope: Pick<StepScope, 'options' | 'sourceId' | 'patterns'>, viewReadable: boolean) =>
  buildToolRegistry({ source: scope.options.folder()?.source(scope.sourceId), patterns: scope.patterns?.built, viewReadable, templateRunnable: (template) => TEMPLATES.includes(template) });

type Answered = Extract<AskAnswer, { answered: unknown }>['answered'];

interface ToolLoopSettings {
  readonly maxCalls: number;
  readonly maxSteps: number;
  readonly maxInputTokens: number;
  /** The rows a turn may read from the source, or none when no limit is set. */
  readonly rowsAllowed?: number;
}

export interface ToolLoopOptions {
  readonly model: AuditedModelCall;
  /** The router's prompt, without its reply format. */
  readonly prompt: () => string | undefined;
  readonly settings: (sourceId: string) => ToolLoopSettings | undefined;
  /** The answer after tool steps: the model's sentences over what the steps returned, checked. */
  readonly answer: (input: ToolAnswerInput) => Promise<ToolAnswerOutcome>;
}

interface LoopBase {
  readonly scope: StepScope;
  readonly message: string;
  readonly deadline: AbortSignal;
  readonly startedAt: number;
  /** The model calls of the turn so far. */
  readonly callsUsed: number;
}

/** The read the route already ran, as the first step of the turn: an Ask read, or the view's reading with the tool request the model gave in place of an answer, which is the next step. */
type LoopStart =
  | { readonly first: { readonly tool: string; readonly answer: Answered }; readonly view?: undefined }
  | { readonly view: { readonly reading: SummaryReading; readonly assembled: AssembledText; readonly request: ToolRequest }; readonly first?: undefined };

export type LoopInput = LoopBase & LoopStart;

export type LoopOutcome =
  /** The model needs nothing more, or the loop could not go on without losing what it had: `answer` is the answer of the last step that read something, and `steps` how many ran. */
  | { readonly kind: 'finished'; readonly answer: Answered; readonly steps: number }
  | { readonly kind: 'heavy'; readonly answer: Answered }
  /** The checked answer after tool steps: sentences that cite the elements the steps returned. */
  | { readonly kind: 'sentences'; readonly answer: Extract<ToolAnswerOutcome, { kind: 'sentences' }>; readonly steps: number; readonly calls: number }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'failed'; readonly why: AssistantFailureKind }
  | { readonly kind: 'limit'; readonly limit: AssistantLimit }
  /** A tool request that is malformed after its repeat, or names a tool that is no longer available. */
  | { readonly kind: 'ended'; readonly because: 'malformed' | 'unavailable' };

/** What the loop reports of the answer call that follows its steps. */
function answered(outcome: ToolAnswerOutcome, steps: number, calls: number): LoopOutcome {
  switch (outcome.kind) {
    case 'sentences':
      return { kind: 'sentences', answer: outcome, steps, calls: calls + outcome.calls };
    case 'unsupported':
      return { kind: 'unsupported' };
    case 'limit':
      return { kind: 'limit', limit: outcome.limit };
    case 'failed':
      return { kind: 'failed', why: outcome.why };
    default: {
      const unreachable: never = outcome;
      return unreachable;
    }
  }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Whether the text is exactly `{"done":true}`. */
function isDone(text: string): boolean {
  try {
    if (text.length > 200 || hasDuplicateKeys(text)) return false;
    const data: unknown = JSON.parse(text);
    return isRecord(data) && Object.keys(data).length === 1 && data['done'] === true;
  } catch {
    return false;
  }
}

const resultLine = (tool: string, answer: Answered): string => {
  const rows = answer.summary?.sentences.map((sentence) => sentence.text).join(' ');
  return `${tool}: ${rows === undefined || rows === '' ? 'read' : rows}`;
};

/**
 * The loop of a turn after its first read: the model is asked for the next step with the masked results so far, replies that it is done or asks for one more registered read, which is run through the gate; the loop
 * ends when the model is done or a limit is reached. A failure of the step call keeps what was read: the answer of the last read stands.
 */
export function createToolLoop(options: ToolLoopOptions): (input: LoopInput) => Promise<LoopOutcome | undefined> {
  return async (input) => {
    const settings = options.settings(input.scope.sourceId);
    const prompt = options.prompt();
    if (settings === undefined || prompt === undefined || settings.maxSteps < 2) return undefined;
    const { scope } = input;
    const source = scope.options.folder()?.source(scope.sourceId);
    const registry = toolRegistryOf(scope, scope.viewElementKeys.length > 0);
    const instructions = buildStepInstructions(source === undefined ? prompt : `${prompt}\n\n# This source's questions\n\n${source.classification.text}`, registry);
    const { view } = input;
    const lines = [view === undefined ? resultLine(input.first.tool, input.first.answer) : `view:\n${view.assembled.text}`];
    const reads: ReadDone[] = view === undefined ? [{ tool: input.first.tool, result: input.first.answer.result }] : [];
    let latest: Answered | undefined = view === undefined ? input.first.answer : undefined;
    let rows = view === undefined ? summarizeRun(input.first.answer.result).rowCount : view.reading.nodes.length + view.reading.edges.length;
    let steps = 1;
    let calls = input.callsUsed;
    let note = '';
    let pending: ToolRequest | undefined = view?.request;
    // an Ask read stands as the answer when nothing came after it; a view's reading has no answer of its own, so a loop entered from it that cannot go on ends with a limit
    const stop = (limit: AssistantLimit): LoopOutcome | undefined => (steps === 1 && view === undefined ? undefined : { kind: 'limit', limit });
    const finished = (): LoopOutcome => (latest === undefined ? { kind: 'failed', why: 'service' } : { kind: 'finished', answer: latest, steps });
    const finalAnswer = async (): Promise<LoopOutcome> =>
      answered(await options.answer({ scope, message: input.message, reads, ...(view === undefined ? {} : { view: { assembled: view.assembled, reading: view.reading } }), steps, callsUsed: calls, maxCalls: settings.maxCalls, maxInputTokens: settings.maxInputTokens, startedAt: input.startedAt, signal: scope.request.signal, deadline: input.deadline }), steps, calls);
    let read: ReturnType<typeof readToolRequest>;
    for (;;) {
      if (scope.request.signal.aborted) throw new Error('the request was cancelled');
      if (pending !== undefined) {
        // the request came with the view's reply: no step call is made for it, and a call is kept for the answer
        if (calls >= settings.maxCalls) return stop('calls') ?? finished();
        if (input.deadline.aborted) return stop('time') ?? finished();
        read = { ok: true, request: pending };
        pending = undefined;
      } else {
        // a call is kept for the answer: when no call is left to choose another read, the answer is drafted over what was read, so a repeat of a step never takes the answer's call
        if (calls + 1 >= settings.maxCalls) return steps === 1 && view === undefined ? finished() : finalAnswer();
        if (input.deadline.aborted) return stop('time') ?? finished();
        // the limits of steps and rows bound the reads, not the answer to the reads made: no call is made to choose a read the turn may not make, and the answer is drafted over what was read
        if (steps >= settings.maxSteps || (settings.rowsAllowed !== undefined && rows >= settings.rowsAllowed)) return steps === 1 ? finished() : finalAnswer();
        const values = `Question:\n${input.message}\n\nMasked results so far:\n${lines.join('\n')}${note}`;
        if (estimateTokens(instructions.text, values) > settings.maxInputTokens) return steps === 1 && view === undefined ? finished() : finalAnswer();
        const reply = await askForStep(options.model, instructions, values, scope, AbortSignal.any([scope.request.signal, input.deadline]));
        calls += 1;
        if (reply === undefined) return finished();
        if (isDone(reply)) return steps === 1 ? finished() : finalAnswer();
        read = readToolRequest(reply, registry);
        const decision = decideToolReply(read, { callsUsed: calls, maxCalls: settings.maxCalls, repeated: note !== '' });
        if (decision === 'repeat') {
          note = `\n\n${REPEAT_NOTE}`;
          continue;
        }
        if (decision === 'malformed' || decision === 'unavailable') return { kind: 'ended', because: decision };
      }
      if (!read.ok) return { kind: 'ended', because: 'malformed' };
      if (steps >= settings.maxSteps) return { kind: 'limit', limit: 'steps' };
      if (settings.rowsAllowed !== undefined && rows >= settings.rowsAllowed) return { kind: 'limit', limit: 'rows' };
      note = '';
      const step = await runToolStep(read.request, scope);
      steps += 1;
      switch (step.status) {
        case 'heavy':
          return { kind: 'heavy', answer: step.answer };
        case 'answered':
          latest = step.answer;
          rows += step.rows;
          lines.push(resultLine(read.request.tool.name, step.answer));
          reads.push({ tool: read.request.tool.name, result: step.answer.result });
          break;
        case 'refused':
          if (step.refused.cause === 'nothing-found') reads.push({ tool: read.request.tool.name });
          lines.push(`${read.request.tool.name}: ${step.refused.cause === 'nothing-found' ? 'nothing found' : 'not read, its values did not fit'}`);
          break;
        case 'view':
          rows += step.rows;
          lines.push(`view: ${step.rows} elements read`);
          break;
        case 'no-view':
          lines.push('view: not available');
          break;
        default: {
          const unreachable: never = step;
          return unreachable;
        }
      }
    }
  };
}

/** One audited call of the step: the text of the reply, or undefined when the call failed or came back with nothing to read. */
async function askForStep(model: AuditedModelCall, instructions: { readonly text: string; readonly sha256: string }, values: string, scope: StepScope, signal: AbortSignal): Promise<string | undefined> {
  const record = startModelCall({ modelRef: model.modelRef, promptId: STEP_PROMPT_ID, promptVersion: STEP_PROMPT_VERSION, instructionsSha256: instructions.sha256, instructions: instructions.text, values });
  try {
    const answer = await model.call(
      { promptId: STEP_PROMPT_ID, version: STEP_PROMPT_VERSION, instructions: instructions.text, values },
      {
        action: STEP_AUDIT_ACTION,
        actorId: scope.request.principalId,
        actorRole: scope.request.principalRole,
        traceId: scope.request.traceId,
        sourceId: scope.sourceId,
        ...(scope.investigationId === undefined ? {} : { investigationId: scope.investigationId }),
        ...(record.runId === undefined ? {} : { runId: record.runId }),
        onProviderAnswer: record.received,
      },
      signal,
    );
    noteModelAnswer({ ...(answer.status === 'ok' ? { model: answer.model } : {}), ...(answer.usage === undefined ? {} : { usage: answer.usage }) });
    record.end({ aborted: signal.aborted });
    return answer.status === 'ok' ? answer.text : undefined;
  } catch (error) {
    record.end({ error, aborted: signal.aborted });
    // an event that cannot be built withholds the answer; any other failure of the call leaves what was read
    if (error instanceof AuditUnavailableError) throw error;
    return undefined;
  }
}
