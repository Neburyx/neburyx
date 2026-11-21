import { ASK_TEMPLATE_IDS, hasDuplicateKeys, type AskAnswer, type AskRunResult, type AssistantRead, type SummaryReading, type AssistantFailureKind, type AssistantLimit } from '@neburyx/contracts';
import { AuditUnavailableError, type AuditedModelCall } from '@neburyx/ee-ai-runtime';
import { assembleText, estimateTokens, type AssembledText } from '../case-summary/assemble.js';
import { summarizeRun } from '../questions/run-summary.js';
import { buildStepInstructions, STEP_PROMPT_ID, STEP_PROMPT_VERSION } from './step-instructions.js';
import { buildToolRegistry } from './tool-registry.js';
import { decideToolReply, readToolRequest, type ToolRequest } from './tool-request.js';
import type { ReadDone, ToolAnswerInput, ToolAnswerOutcome } from './tool-answer.js';
import type { PlanStep } from './plan-token.js';
import { readNotRead, readOfAnswer, readOfNothing, readOfNotes, readOfSummary, readOfTypology, readOfView } from './reads.js';
import { runToolStep, type StepResult, type StepScope } from './tool-step.js';
import { stepsOf } from './steps.js';
import { noteModelAnswer, noteReplaying, startModelCall } from './turn-audit.js';

const STEP_AUDIT_ACTION = 'assistant.step';
const REPEAT_NOTE = 'Your last reply was not valid. Reply with {"done":true} or one tool request only: start with { and write nothing before or after it, no reasoning.';
const TEMPLATES: readonly string[] = ASK_TEMPLATE_IDS;

/** The tools a turn may ask for in this scope: the source's intents, the catalog templates, the person's patterns and, when it can be read again, the view. */
const typologyOf = (scope: Pick<StepScope, 'options'>): readonly string[] | undefined => scope.options.typology?.();

export const toolRegistryOf = (scope: Pick<StepScope, 'options' | 'sourceId' | 'patterns' | 'request' | 'viewElementKeys'>, viewReadable: boolean) =>
  buildToolRegistry({ source: scope.options.folder()?.source(scope.sourceId), patterns: scope.patterns?.built, viewReadable, templateRunnable: (template) => TEMPLATES.includes(template), notes: scope.request.aiNotes !== undefined, summary: scope.viewElementKeys.length > 0 && scope.request.caseSummarizer.availability().available, ...(typologyOf(scope) === undefined ? {} : { typology: typologyOf(scope) }) });

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
  /** What the router was given of the person's earlier turns, so that the answer can place a follow-up. */
  readonly context?: string;
}

/** The read the route already ran, as the first step of the turn: an Ask read, or the view's reading with the tool request the model gave in place of an answer, which is the next step. */
type LoopStart =
  /** `asked` is what the router named: for a saved pattern, its key in the catalog and the pattern's own values. */
  | { readonly first: { readonly tool: string; readonly answer: Answered; readonly asked?: Readonly<Record<string, string>> }; readonly view?: undefined; readonly resume?: undefined }
  | { readonly view: { readonly reading: SummaryReading; readonly assembled: AssembledText; readonly request: ToolRequest }; readonly first?: undefined; readonly resume?: undefined }
  /** A turn that went on after the analyst's decision on a heavy step: the earlier steps are read again, then the step is read (confirm) or left out (skip), and the loop goes on. */
  | { readonly resume: ResumeState; readonly first?: undefined; readonly view?: undefined };

export interface ResumeState {
  readonly steps: readonly PlanStep[];
  readonly wait: PlanStep;
  readonly fromView: boolean;
  readonly decision: 'confirm' | 'skip';
  /** The steps, rows and model calls the turn had before the wait. */
  readonly counters: { readonly steps: number; readonly rows: number; readonly calls: number };
}

export type LoopInput = LoopBase & LoopStart;

export type LoopOutcome =
  /** The model needs nothing more, or the loop could not go on without losing what it had: `answer` is the answer of the last step that read something, and `steps` how many ran. */
  | { readonly kind: 'finished'; readonly answer: Answered; readonly steps: number; readonly reads: readonly AssistantRead[]; readonly stoppedAt?: AssistantLimit }
  /** A heavy step the analyst has to confirm: nothing of it was read. The steps before it and the counters are what a decision needs to go on. */
  | { readonly kind: 'waiting'; readonly wait: { readonly request: ToolRequest; readonly answer: Answered }; readonly steps: readonly PlanStep[]; readonly counters: { readonly steps: number; readonly rows: number; readonly calls: number }; readonly reads: readonly AssistantRead[]; readonly fromView: boolean }
  /** The checked answer after tool steps: sentences that cite the elements the steps returned. */
  | { readonly kind: 'sentences'; readonly answer: Extract<ToolAnswerOutcome, { kind: 'sentences' }>; readonly steps: number; readonly calls: number; readonly reads: readonly AssistantRead[]; readonly stoppedAt?: AssistantLimit }
  | { readonly kind: 'no-description'; readonly sentence: string; readonly names: readonly string[]; readonly calls: number }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'failed'; readonly why: AssistantFailureKind }
  | { readonly kind: 'limit'; readonly limit: AssistantLimit; readonly reads: readonly AssistantRead[] }
  /** A tool request that is malformed after its repeat, or names a tool that is no longer available. */
  | { readonly kind: 'ended'; readonly because: 'malformed' | 'unavailable' };

/** What the loop reports of the answer call that follows its steps. */
function answered(outcome: ToolAnswerOutcome, steps: number, calls: number, reads: readonly AssistantRead[], stoppedAt?: AssistantLimit): LoopOutcome {
  switch (outcome.kind) {
    case 'sentences':
      return { kind: 'sentences', answer: outcome, steps, calls: calls + outcome.calls, reads, ...(stoppedAt === undefined ? {} : { stoppedAt }) };
    case 'noDescription':
      return { kind: 'no-description', sentence: outcome.sentence, names: outcome.names, calls: calls + outcome.calls };
    case 'unsupported':
      return { kind: 'unsupported' };
    case 'limit':
      return { kind: 'limit', limit: outcome.limit, reads };
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
    const { resume } = input;
    const fromView = input.view !== undefined || resume?.fromView === true;
    let view: { readonly reading: SummaryReading; readonly assembled: AssembledText } | undefined = input.view === undefined ? undefined : { reading: input.view.reading, assembled: input.view.assembled };
    const lines: string[] = [];
    const reads: ReadDone[] = [];
    const entries: AssistantRead[] = [];
    // the plain-words label of an intent travels with its read, for the card, the step line and the text the model reads; templates, patterns and the view have none
    const labelFor = (tool: string): { readonly label?: string } => {
      const found = registry.find(tool);
      return found?.kind === 'intent' && found.label !== undefined ? { label: found.label } : {};
    };
    // the read a turn arrives with was told to a streamed turn when it finished, by the route that ran it
    const put = (entry: AssistantRead, told = false): void => {
      const listed = { ...entry, ...(entry.kind === 'intent' ? labelFor(entry.tool) : {}) };
      entries.push(listed);
      if (!told) stepsOf(scope.request).readDone(listed);
    };
    // the steps of the turn that a decision reads again: each tool and the values the gate accepted for it
    const done: PlanStep[] = [];
    let latest: Answered | undefined;
    let rows = 0;
    let steps = resume === undefined ? 1 : resume.counters.steps;
    let calls = resume === undefined ? input.callsUsed : resume.counters.calls;
    let note = '';
    // the reading an AI case summary of this turn was drafted over, kept for another request for it
    let summaryReading: SummaryReading | undefined;
    let pending: ToolRequest | undefined = input.view?.request;
    if (input.first !== undefined) {
      const { answer } = input.first;
      // a saved pattern the router ran is a tool of the registry under its catalog key, which is what the router named in its `pattern` value; its other values are its own
      const { pattern, ...ownValues } = input.first.asked ?? answer.entities;
      const firstTool = answer.patternName === undefined ? input.first.tool : (pattern ?? input.first.tool);
      lines.push(resultLine(input.first.tool, answer));
      reads.push({ tool: input.first.tool, result: answer.result, ...labelFor(input.first.tool) });
      put(readOfAnswer(answer.patternName === undefined ? 'intent' : 'pattern', answer.patternName ?? input.first.tool, answer), true);
      done.push({ tool: firstTool, values: answer.patternName === undefined ? answer.entities : ownValues });
      latest = input.first.answer;
      rows = summarizeRun(input.first.answer.result).rowCount;
    } else if (input.view !== undefined) {
      lines.push(`view:\n${input.view.assembled.text}`);
      put(readOfView(input.view.reading.nodes.length + input.view.reading.edges.length));
      rows = input.view.reading.nodes.length + input.view.reading.edges.length;
    }
    // an Ask read stands as the answer when nothing came after it; a view's reading has no answer of its own, so a loop entered from it that cannot go on ends with a limit
    const stop = (limit: AssistantLimit): LoopOutcome | undefined => (steps === 1 && !fromView ? undefined : { kind: 'limit', limit, reads: entries });
    const finished = (stoppedAt?: AssistantLimit): LoopOutcome => (latest === undefined ? { kind: 'failed', why: 'service' } : { kind: 'finished', answer: latest, steps, reads: entries, ...(stoppedAt === undefined ? {} : { stoppedAt }) });
    const finalAnswer = async (stoppedAt?: AssistantLimit): Promise<LoopOutcome> => {
      stepsOf(scope.request).answering();
      return answered(await options.answer({ scope, message: input.message, reads, ...(input.context === undefined ? {} : { context: input.context }), ...(view === undefined ? {} : { view }), steps, callsUsed: calls, maxCalls: settings.maxCalls, maxInputTokens: settings.maxInputTokens, startedAt: input.startedAt, signal: scope.request.signal, deadline: input.deadline }), steps, calls, entries, stoppedAt);
    };
    /** What one step of the turn, made now or read again, adds to what the model sees and to the reads of the turn. */
    const apply = (request: ToolRequest, step: StepResult, how: { readonly confirmed?: boolean } = {}): void => {
      const { tool, values } = request;
      const mark = how.confirmed === true ? { confirmed: true as const } : {};
      switch (step.status) {
        case 'answered':
          latest = step.answer;
          rows += step.rows;
          put(readOfAnswer(tool.kind, step.answer.patternName ?? tool.name, step.answer));
          lines.push(resultLine(tool.name, step.answer));
          reads.push({ tool: tool.name, result: step.answer.result, ...labelFor(tool.name) });
          done.push({ tool: tool.name, values, ...mark });
          break;
        case 'heavy':
          // a read that has grown past what Ask reads at once since it was read, found again: it is not read, and a decision never leads to another
          put(readNotRead(tool.kind, tool.name));
          lines.push(`${tool.name}: not read, it is larger than one read now`);
          done.push({ tool: tool.name, values, ...mark });
          break;
        case 'refused':
          if (step.refused.cause === 'nothing-found') reads.push({ tool: tool.name, ...labelFor(tool.name) });
          put(step.refused.cause === 'nothing-found' ? readOfNothing(tool.kind, tool.name, values) : readNotRead(tool.kind, tool.name));
          lines.push(`${tool.name}: ${step.refused.cause === 'nothing-found' ? 'nothing found' : 'not read, its values did not fit'}`);
          done.push({ tool: tool.name, values, ...mark });
          break;
        case 'view':
          rows += step.rows;
          view ??= { reading: step.reading, assembled: assembleText(step.reading) };
          put(readOfView(step.rows));
          lines.push(`view: ${step.rows} elements read`);
          done.push({ tool: tool.name, values, ...mark });
          break;
        case 'no-view':
          put(readNotRead('view', 'view'));
          lines.push('view: not available');
          done.push({ tool: tool.name, values, ...mark });
          break;
        case 'ai-notes':
          rows += step.rows;
          put(readOfNotes(step.rows, step.notRead > 0));
          lines.push(`ai-notes: ${step.sentences.length} ${step.sentences.length === 1 ? 'sentence' : 'sentences'}${step.notRead > 0 ? `, ${step.notRead} ${step.notRead === 1 ? 'entry' : 'entries'} not read` : ''}${step.sentences.map((sentence) => `\n- ${sentence.text}`).join('')}`);
          reads.push({ tool: tool.name, written: { sentences: step.sentences, notRead: step.notRead } });
          done.push({ tool: tool.name, values, ...mark });
          break;
        case 'ai-summary':
          rows += step.rows;
          put(readOfSummary(step.rows));
          lines.push(`ai-summary: ${step.sentences.length} ${step.sentences.length === 1 ? 'sentence' : 'sentences'}${step.sentences.map((sentence) => `\n- ${sentence.text}`).join('')}`);
          reads.push({ tool: tool.name, written: { sentences: step.sentences, notRead: 0 } });
          done.push({ tool: tool.name, values, ...mark });
          break;
        case 'no-summary':
          put(readNotRead('ai-summary', 'ai-summary'));
          lines.push('ai-summary: not drafted');
          done.push({ tool: tool.name, values, ...mark });
          break;
        case 'no-notes':
          put(readNotRead('ai-notes', 'ai-notes'));
          lines.push('ai-notes: not read');
          done.push({ tool: tool.name, values, ...mark });
          break;
        case 'typology':
          put(readOfTypology(step.lines.length));
          lines.push(`typology:\n${step.lines.map((line) => `- ${line}`).join('\n')}`);
          reads.push({ tool: tool.name, typology: step.lines });
          done.push({ tool: tool.name, values, ...mark });
          break;
        default: {
          const unreachable: never = step;
          return unreachable;
        }
      }
    };
    if (resume !== undefined) {
      // the earlier reads of the turn are made again through the gate, as of now: their results were never kept
      noteReplaying(true);
      try {
        if (resume.fromView) {
          const viewTool = registry.find('view');
          const again = viewTool === undefined ? undefined : await runToolStep({ tool: viewTool, values: {} }, scope);
          if (again?.status === 'view') {
            view = { reading: again.reading, assembled: assembleText(again.reading) };
            rows += again.rows;
            put(readOfView(again.rows));
            lines.push(`view:\n${view.assembled.text}`);
          } else {
            put(readNotRead('view', 'view'));
            lines.push('view: not available');
          }
        }
        for (const earlier of resume.steps) {
          if (scope.request.signal.aborted) throw new Error('the request was cancelled');
          if (input.deadline.aborted) return { kind: 'limit', limit: 'time', reads: entries };
          const tool = registry.find(earlier.tool);
          if (tool === undefined || !tool.available) {
            put(readNotRead(tool?.kind ?? 'intent', earlier.tool));
            lines.push(`${earlier.tool}: not read, it is not available now`);
            continue;
          }
          if (tool.kind === 'ai-summary') {
            // a summary costs model calls and may differ: it is not drafted again after a wait
            put(readNotRead('ai-summary', 'ai-summary'));
            lines.push('ai-summary: not read, it is not drafted again after a wait');
            continue;
          }
          const request = { tool, values: earlier.values };
          apply(request, await runToolStep(request, scope, { continuing: earlier.confirmed === true }), { ...(earlier.confirmed === true ? { confirmed: true } : {}) });
        }
      } finally {
        noteReplaying(false);
      }
      const tool = registry.find(resume.wait.tool);
      if (tool === undefined || !tool.available) {
        put(readNotRead(tool?.kind ?? 'intent', resume.wait.tool));
        lines.push(`${resume.wait.tool}: not read, it is not available now`);
      } else if (resume.decision === 'skip') {
        put(readNotRead(tool.kind, resume.wait.tool));
        lines.push(`${resume.wait.tool}: skipped by the analyst`);
      } else {
        // every limit is checked again before the heavy step is read: a decision never lifts one
        if (steps >= settings.maxSteps) return finalAnswer('steps');
        if (settings.rowsAllowed !== undefined && rows >= settings.rowsAllowed) return finalAnswer('rows');
        if (input.deadline.aborted) return { kind: 'limit', limit: 'time', reads: entries };
        if (calls + 1 >= settings.maxCalls) return { kind: 'limit', limit: 'calls', reads: entries };
        if (estimateTokens(instructions.text, `Question:\n${input.message}\n\nMasked results so far:\n${lines.join('\n')}`) > settings.maxInputTokens) return { kind: 'limit', limit: 'input', reads: entries };
        if (scope.request.signal.aborted) throw new Error('the request was cancelled');
        const request = { tool, values: resume.wait.values };
        const confirmed = await runToolStep(request, scope, { continuing: true });
        steps += 1;
        apply(request, confirmed, { confirmed: true });
      }
    }
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
        if (calls + 1 >= settings.maxCalls) return steps === 1 && !fromView ? finished('calls') : finalAnswer('calls');
        if (input.deadline.aborted) return stop('time') ?? finished();
        // the limits of steps and rows bound the reads, not the answer to the reads made: no call is made to choose a read the turn may not make, and the answer is drafted over what was read
        if (steps >= settings.maxSteps || (settings.rowsAllowed !== undefined && rows >= settings.rowsAllowed)) {
          const reached = steps >= settings.maxSteps ? 'steps' : 'rows';
          return steps === 1 ? finished(reached) : finalAnswer(reached);
        }
        const values = `Question:\n${input.message}\n\nMasked results so far:\n${lines.join('\n')}${note}`;
        if (estimateTokens(instructions.text, values) > settings.maxInputTokens) return steps === 1 && !fromView ? finished('input') : finalAnswer('input');
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
      if (steps >= settings.maxSteps) return { kind: 'limit', limit: 'steps', reads: entries };
      if (settings.rowsAllowed !== undefined && rows >= settings.rowsAllowed) return { kind: 'limit', limit: 'rows', reads: entries };
      note = '';
      // the summary is a model call that counts in the turn's: it is not started when the turn has no call to spare besides the one kept for the answer
      const summarizing = read.request.tool.kind === 'ai-summary';
      if (summarizing && settings.maxCalls - calls - 1 < 1) return steps === 1 && !fromView ? finished('calls') : finalAnswer('calls');
      const reading = view?.reading ?? summaryReading;
      let step: StepResult;
      try {
        step = await runToolStep(read.request, scope, summarizing ? { ...(reading === undefined ? {} : { viewReading: reading }), callsBudget: settings.maxCalls - calls - 1, deadline: input.deadline } : {});
      } catch (error) {
        // a summary that ended with the turn's time ends the turn at its time limit, as a model call that does so; a cancel is the caller's
        if (summarizing && input.deadline.aborted && !scope.request.signal.aborted) return { kind: 'limit', limit: 'time', reads: entries };
        throw error;
      }
      // a read Ask would stop as heavy is not read: the turn waits for the analyst, and the step does not count
      if (step.status === 'heavy') return { kind: 'waiting', wait: { request: read.request, answer: step.answer }, steps: done, counters: { steps, rows, calls }, reads: entries, fromView };
      steps += 1;
      if (step.status === 'ai-summary') {
        summaryReading = step.reading;
        calls += step.calls;
      } else if (step.status === 'no-summary') calls += step.calls;
      apply(read.request, step);
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
