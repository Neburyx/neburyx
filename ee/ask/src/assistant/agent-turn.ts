import { z } from 'zod';
import { ASSISTANT_LAST_CALL_SENTENCE, ASSISTANT_POINTER_SENTENCES, ASSISTANT_POINTERS, type AskAnswer, type AssistantLimit, type AssistantPointer, type AssistantRead, type SummaryReading, type SummarySentence } from '@neburyx/contracts';
import { AuditedModelFailure, runAgent, type AgentChatModel, type AgentRun, type AgentControl, type AgentTool, type AuditedModelHook } from '@neburyx/ee-assistant-agent';
import { AuditUnavailableError, removalNoteOf, type AuditedCallContext, type CheckRunner, type RejectedSentence } from '@neburyx/ee-ai-runtime';
import { assembleText, estimateTokens, type AssembledText } from '../case-summary/assemble.js';
import { judgeCheck } from '../case-summary/judge.js';
import { judgeTableRows, parseTable, rowSentenceOf } from './table.js';
import { viewCoverageOf } from '../case-summary/coverage.js';
import { assembleResults, answerBasisOf, failureOf, outcomeOfDraft, typeNamesOf, withElementsOfNotes, type ReadDone, type ToolAnswerOutcome } from './tool-answer.js';
import { readNotRead, readOfAnswer, readOfNothing, readOfNotes, readOfSummary, readOfTypology, readOfView } from './reads.js';
import { afterReads, toolRegistryOf, type LoopOutcome, type ResumeState } from './turn-outcome.js';
import type { PlanStep } from './plan-token.js';
import type { Tool } from './tool-registry.js';
import { runToolStep, type StepResult, type StepScope } from './tool-step.js';
import { shareSteps, stepsOf } from './steps.js';
import { noDescriptionSentence, undescribedNamesOf } from './type-lines.js';
import { noteModelAnswer, notePropertyValuesSent, noteReplaying, startModelCall } from './turn-audit.js';
import type { ViewInstructions } from './view-instructions.js';

const AGENT_AUDIT_ACTION = 'assistant.agent';
export const AGENT_PROMPT_ID = 'assistant.agent';
export const AGENT_PROMPT_VERSION = 1;
const ANSWER_TOOL = 'answer';
const REPLY_FORMAT_HEADING = '# Reply format';
const FINAL_TEXT = 'Done.';
const NOT_ANSWERED = 'Nothing has been read yet. Read first, then call answer.';
const LIMIT_TEXT = 'Not read: this turn has reached its limit. Call answer now with what you have.';

/** What the model is told when `answer` removes sentences. A caller may replace it; the default says how many were removed and names each removed sentence with its reason. */
type RemovalFeedback = (outcome: { readonly kept: number; readonly removed: number; readonly verdictFound: boolean; readonly rejected: readonly RejectedSentence[] }) => string;

const plainFeedback: RemovalFeedback = ({ kept, removed, verdictFound, rejected }) =>
  removed === 0 ? `Checked: all ${kept} sentences kept. Reply "${FINAL_TEXT}".` : `Checked: ${kept} sentences kept, ${removed} removed${verdictFound ? ' (verdict wording found)' : ''}. Call answer again with sentences that cite elements, or reply "${FINAL_TEXT}".${rejected.length === 0 ? '' : `\n${removalNoteOf(rejected)}`}`;

interface AgentTurnSettings {
  readonly maxCalls: number;
  readonly maxSteps: number;
  readonly maxInputTokens: number;
  /** The rows a turn may read from the source, or none when no limit is set. */
  readonly rowsAllowed?: number;
  readonly timeoutMs: number;
}

export interface AgentTurnOptions {
  /** The chat model of one turn, with the audit under it; undefined when the provider is not usable. */
  readonly model: (context: () => AuditedCallContext, trace: AuditedModelHook['trace']) => Promise<AgentChatModel | undefined>;
  readonly modelRef: () => string | undefined;
  readonly instructions: (sourceId: string) => ViewInstructions | undefined;
  readonly settings: (sourceId: string) => AgentTurnSettings | undefined;
  readonly checks: CheckRunner;
  readonly removalFeedback?: RemovalFeedback;
  /** Called with the run of each turn after it ended: a test reads what the framework assembled and what was offered. */
  readonly onRun?: (run: AgentRun) => void;
}

export interface AgentTurnInput {
  readonly scope: StepScope;
  readonly message: string;
  readonly deadline: AbortSignal;
  readonly startedAt: number;
  /** The model calls the turn made before the agent (the router's). */
  readonly callsUsed: number;
  readonly context?: string;
  /** The route the router chose, kept with a heavy read so that the turn after the decision answers as the same route. */
  readonly route?: 'ask' | 'view';
  /** The turn after the analyst's decision on a heavy read: the earlier reads are made again, then the step is read (confirm) or left out (skip). */
  readonly resume?: ResumeState;
}

type Standing = Extract<ToolAnswerOutcome, { kind: 'sentences' | 'table' }> | Extract<ToolAnswerOutcome, { kind: 'noDescription' | 'unsupported' }>;

const sentenceSchema = z.object({ text: z.string().min(1), cites: z.array(z.string()) });
/** The fixed sentence of the pointer the model named, on an answer that stands: the model never writes it. */
const withPointer = <T extends { readonly kind: 'sentences' | 'table' }>(outcome: T, pointer: AssistantPointer | undefined): T => (pointer === undefined ? outcome : { ...outcome, pointer: ASSISTANT_POINTER_SENTENCES[pointer] });
const noDescriptionSchema = z.array(z.string()).optional();
const pointerSchema = z.enum(ASSISTANT_POINTERS).optional();
const answerSchema = z.object({ sentences: z.array(sentenceSchema).min(1), noDescription: noDescriptionSchema, pointer: pointerSchema });
const tableSchema = z.object({ columns: z.array(z.string()).min(1), rows: z.array(z.object({ cells: z.array(z.string()), cites: z.array(z.string()) })).min(1), noDescription: noDescriptionSchema, pointer: pointerSchema });

function paramsSchema(tool: Tool): z.ZodObject<z.ZodRawShape> {
  return z.strictObject(Object.fromEntries(tool.parameters.map((name) => [name, z.string().min(1)])));
}

const describeTool = (tool: Tool): string => `${tool.label === undefined ? tool.name : `${tool.label} (${tool.name})`}${tool.description === undefined ? '' : `: ${tool.description}`}. Values: ${tool.parameters.join(', ') || 'none'}.`;

/**
 * One assistant turn on deepagents: the model reads only through the tools of the registry, each run by the same gated step as before, and answers only through `answer`, whose sentences go through the product's checks.
 * The text the model writes outside `answer` is never shown. Undefined when the turn cannot start (no instructions, no model, no settings).
 */
export function createAgentTurn(options: AgentTurnOptions): (input: AgentTurnInput) => Promise<LoopOutcome | undefined> {
  const feedback = options.removalFeedback ?? plainFeedback;
  return async (input) => {
    const { scope } = input;
    const instructions = options.instructions(scope.sourceId);
    const modelRef = options.modelRef();
    const settings = options.settings(scope.sourceId);
    if (instructions === undefined || modelRef === undefined || settings === undefined) return undefined;
    let runId: string | undefined;
    const trace: AuditedModelHook['trace'] = (call) => {
      const record = startModelCall({ modelRef, promptId: AGENT_PROMPT_ID, promptVersion: AGENT_PROMPT_VERSION, instructionsSha256: call.instructionsSha256, instructions: call.instructions, values: call.values, tools: call.tools });
      runId = record.runId;
      return {
        received: (answer) => {
          record.received({ status: 'ok', ...answer });
          noteModelAnswer({ model: answer.model, usage: answer.usage });
        },
        end: record.end,
      };
    };
    const model = await options.model(() => ({ action: AGENT_AUDIT_ACTION, actorId: scope.request.principalId, actorRole: scope.request.principalRole, traceId: scope.request.traceId, sourceId: scope.sourceId, ...(scope.investigationId === undefined ? {} : { investigationId: scope.investigationId }), ...(runId === undefined ? {} : { runId }) }), trace);
    if (model === undefined) return undefined;
    const registry = toolRegistryOf(scope, scope.viewElementKeys.length > 0);
    const readable = registry.tools.filter((tool) => tool.available);
    const reads: ReadDone[] = [];
    const entries: AssistantRead[] = [];
    let view: { readonly reading: SummaryReading; readonly assembled: AssembledText } | undefined;
    let standing: Standing | undefined;
    let ended: LoopOutcome | undefined;
    const control: AgentControl = { stop: false, calls: 0, extra: 0, answerOnly: false };
    const signal = AbortSignal.any([scope.request.signal, input.deadline]);
    // the reads run under the turn's time as well as the request's cancel
    const readRequest = { ...scope.request, signal };
    shareSteps(scope.request, readRequest);
    const readScope: StepScope = { ...scope, request: readRequest };
    const callsNow = (): number => input.callsUsed + control.calls + control.extra;
    let steps = 0;
    let rows = 0;
    let limited: AssistantLimit | undefined;
    let onLastCall = false;
    let askAnswer: Extract<AskAnswer, { answered: unknown }>['answered'] | undefined;
    // the lines of notes and of a summary the application drafted are model-written context beside the elements, never a source of the checks
    const render = (): string => {
      const { assembled, noteLines } = assembleResults(reads, view?.assembled, typeNamesOf(scope.request, scope.sourceId), view === undefined ? undefined : viewCoverageOf(view.reading, typeNamesOf(scope.request, scope.sourceId)));
      const meaning = answerBasisOf({ reads, ...(view === undefined ? {} : { view }), scope, message: input.message })?.typeLines.section ?? '';
      return `Keys are renumbered after every read: cite only keys of the latest result.\n${assembled.text}${noteLines.length === 0 ? '' : `\n${noteLines.join('\n')}`}${meaning}`;
    };
    // the plain-words label of an intent travels with its read, for the card and the step line
    const put = (entry: AssistantRead): void => {
      const found = registry.find(entry.tool);
      const listed = entry.kind === 'intent' && found?.kind === 'intent' && found.label !== undefined ? { ...entry, label: found.label } : entry;
      entries.push(listed);
      stepsOf(scope.request).readDone(listed);
    };

    const done: PlanStep[] = [];
    const apply = (tool: Tool, values: Readonly<Record<string, string>>, step: StepResult, confirmed = false): string => {
      done.push({ tool: tool.name, values, ...(confirmed ? { confirmed: true as const } : {}) });
      switch (step.status) {
        case 'view':
          view ??= { reading: step.reading, assembled: assembleText(step.reading) };
          put(readOfView(step.rows));
          return render();
        case 'no-view':
          put(readNotRead('view', 'view'));
          return 'The view is not available.';
        case 'answered':
          put(readOfAnswer(tool.kind === 'pattern' ? 'pattern' : 'intent', step.answer.patternName ?? tool.name, step.answer));
          reads.push({ tool: tool.name, result: step.answer.result, ...(tool.label === undefined ? {} : { label: tool.label }) });
          if (tool.kind === 'intent') askAnswer = step.answer;
          return render();
        case 'refused':
          if (step.refused.cause === 'value-not-fit') {
            ended = { kind: 'misfit', refused: entries.length === 0 ? step.refused : afterReads(step.refused), reads: entries };
            control.stop = true;
            return 'The values did not fit; the turn ends.';
          }
          put(step.refused.cause === 'nothing-found' ? readOfNothing(tool.kind === 'pattern' ? 'pattern' : 'intent', tool.name, values) : readNotRead('intent', tool.name));
          if (step.refused.cause === 'nothing-found') reads.push({ tool: tool.name, ...(tool.label === undefined ? {} : { label: tool.label }) });
          return step.refused.cause === 'nothing-found' ? 'Nothing was found.' : 'Not read.';
        case 'heavy':
          done.pop();
          ended = { kind: 'waiting', wait: { request: { tool, values }, answer: step.answer }, steps: [...done], counters: { steps: Math.max(1, steps), rows, calls: callsNow() }, reads: entries, fromView: input.route === 'view' };
          control.stop = true;
          return 'This read needs the analyst to confirm it; the turn waits.';
        case 'typology':
          put(readOfTypology(step.lines.length));
          reads.push({ tool: tool.name, typology: step.lines });
          return render();
        case 'ai-notes':
          put(readOfNotes(step.rows, step.notRead > 0));
          reads.push({ tool: tool.name, written: { sentences: step.sentences, notRead: step.notRead } });
          return render();
        case 'ai-summary':
          put(readOfSummary(step.rows));
          reads.push({ tool: tool.name, written: { sentences: step.sentences, notRead: 0 } });
          return render();
        case 'no-summary':
          put(readNotRead('ai-summary', 'ai-summary'));
          return 'The summary was not drafted.';
        case 'no-notes':
          put(readNotRead('ai-notes', 'ai-notes'));
          return 'The notes could not be read.';
        default: {
          const unreachable: never = step;
          return unreachable;
        }
      }
    };

    const rules = instructions.text.split(REPLY_FORMAT_HEADING)[0] ?? '';
    const source = scope.options.folder()?.source(scope.sourceId);
    const system = `${rules}\n\n${source === undefined ? '' : `# This source's questions\n\n${source.classification.text}\n\n`}# How you work\n\nYou are an investigator's assistant. You read only through the tools you were given, and every read goes through the gate. Read what you need, then call answer once. You cannot change the canvas: for a message that asks to expand, add or draw something, read what it asks for with your tools, answer from what they return, and set the answer's pointer to canvas-expand (the server writes the sentence; never write it yourself). For a message that asks how many there are, read the degree preview of the element: its line states the connected elements by type with their quality; answer in plain words, for example \"<element title> has 169,756 <type name> (exact)\", keeping the figure and the quality as the line writes them, and cite both the element and the line, never a total no line states; the check removes any sentence that is not supported by the lines it cites. A message may ask for more than one thing, for example how many of one kind are in view and how many relationships an element has: answer every part, each in a sentence of its own. State a count as a number with its quality as the line that states it writes it; the number of element lines of one type in the view is a count you may state from the view itself. A part that no line supports, such as a count no line states, gets a sentence that says plainly that it is not yet retrieved, and that sentence cites the line that shows what is missing; a part is never left out. A sentence that says what the lines do not show cites the elements or the read line it speaks of, and only those. A sentence that says the view holds no relationship (or no element of some kind), or what the view does not show, cites the line c1, the coverage of the view: how many entities and relationships it shows and what is not yet retrieved; a sentence about what a read did not return cites that read's own line, and states only what that line says. Never cite a key only to keep a sentence: a sentence that cites nothing is removed, and that part goes unanswered. The view holds only the relationships drawn on the canvas (its Relationships lines): a question about who or what an element is connected to, in either direction, that those lines do not answer is answered by reading that element's neighbours with expand or linked-entities before you say it is not shown, and when it needs more reads than the steps allow, say plainly what was not read. When a read answers only half of a question (it finds which element is the largest, the latest or the first, but not what it is connected to, which the question also asks), take the second step: read the neighbours of that element before you say the rest is not shown, within the steps allowed. When a sentence says how many, it cites every element it counts in that same sentence. A sentence that says all, each, every or "the ... on screen", or that compares (the latest, the largest, the most), cites every element it speaks of in that same sentence, as a count does; when only some are cited, say "some" or name them. Name a link between two elements only when a relationship line you cite holds it: never write that an element is "for" or "of" another, or that one sent to or received from another, unless a cited relationship line says so. After answer, reply "${FINAL_TEXT}" and nothing else.`;

    // the state before each read of the tool loop, in order: a request sent without its newest reads takes them back, so that the answer is judged against what the model holds
    const snapshots: { reads: number; entries: number; done: number; view: typeof view; askAnswer: typeof askAnswer; steps: number; rows: number; limited: AssistantLimit | undefined }[] = [];
    const takeBack = (kept: number): void => {
      const target = snapshots[kept];
      if (target === undefined) return;
      reads.length = target.reads;
      entries.length = target.entries;
      done.length = target.done;
      view = target.view;
      askAnswer = target.askAnswer;
      steps = target.steps;
      rows = target.rows;
      limited = target.limited;
      snapshots.length = kept;
    };
    const tools: AgentTool[] = readable.map((tool) => ({
      name: tool.name,
      description: describeTool(tool),
      schema: paramsSchema(tool),
      run: async (args) => {
        snapshots.push({ reads: reads.length, entries: entries.length, done: done.length, view, askAnswer, steps, rows, limited });
        if (steps >= settings.maxSteps) limited ??= 'steps';
        else if (settings.rowsAllowed !== undefined && rows >= settings.rowsAllowed) limited ??= 'rows';
        if (limited !== undefined) {
          control.answerOnly = true;
          return LIMIT_TEXT;
        }
        const values = Object.fromEntries(Object.entries(args).map(([key, value]) => [key, String(value)]));
        const summarizing = tool.kind === 'ai-summary';
        const budget = settings.maxCalls - input.callsUsed - control.calls - control.extra - 1;
        if (summarizing && budget < 1) {
          limited ??= 'calls';
          control.answerOnly = true;
          return LIMIT_TEXT;
        }
        const step = await runToolStep({ tool, values }, readScope, summarizing ? { ...(view === undefined ? {} : { viewReading: view.reading }), callsBudget: budget, deadline: input.deadline } : {});
        if (step.status === 'ai-summary' || step.status === 'no-summary') control.extra += step.calls;
        if (step.status !== 'heavy') steps += 1;
        if ('rows' in step) rows += step.rows;
        const text = apply(tool, values, step);
        if (estimateTokens(system, text) > settings.maxInputTokens) {
          // the result does not go to the model, so the read is taken back as if it had not been made: the answer is judged against the lines the model holds
          takeBack(snapshots.length - 1);
          limited ??= 'input';
          control.answerOnly = true;
          return LIMIT_TEXT;
        }
        notePropertyValuesSent(assembleResults(reads, view?.assembled, typeNamesOf(scope.request, scope.sourceId), view === undefined ? undefined : viewCoverageOf(view.reading, typeNamesOf(scope.request, scope.sourceId))).assembled.carriesPropertyValues);
        return text;
      },
    }));
    tools.push({
      name: ANSWER_TOOL,
      description: scope.form === 'table' ? 'Give the final answer as a table: columns, and one row for each element, with the row\'s own values in cells and the keys of the elements it rests on in cites. Call it once when you have what you need.' : 'Give the final answer: short sentences, each with the keys of the elements it rests on in cites. Call it once when you have what you need.',
      schema: scope.form === 'table' ? tableSchema : answerSchema,
      run: async (args) => {
        stepsOf(scope.request).answering();
        // an answer written on the last call the turn allows, where no read was offered: said so in a fixed sentence, whether the model was done or not
        const isLast = control.calls + control.extra + input.callsUsed >= settings.maxCalls;
        const basis = answerBasisOf({ reads, ...(view === undefined ? {} : { view }), scope, message: input.message });
        if (basis === undefined) return NOT_ANSWERED;
        if (scope.form === 'table') {
          const draft = parseTable({ columns: args['columns'], rows: args['rows'] });
          const askedNames = tableSchema.shape.noDescription.parse(args['noDescription']);
          const named = askedNames === undefined ? undefined : undescribedNamesOf(askedNames, basis.typeLines);
          if (draft === undefined) return 'The table is not valid: use the columns and rows shape, within the bounds. Call answer again.';
          const judgedRows = await judgeTableRows({ rows: draft.rows.map(rowSentenceOf), columns: draft.columns, checks: options.checks, judge: judgeCheck, text: basis.checkedText, timeoutMs: settings.timeoutMs, signal, drop: (row) => row.cites.some((key) => !basis.assembled.keys.has(key)) });
          if ('refused' in judgedRows) return 'The answer could not be checked. Reply "Done."';
          const tabled = outcomeOfDraft({ drafted: { status: 'drafted', table: draft, sentences: judgedRows.kept, removed: judgedRows.removed, calls: 0, verdictFound: judgedRows.verdictFound, model: modelRef, ...(named === undefined ? {} : { noDescription: noDescriptionSentence(named) }) }, basis, input: { reads, scope }, modelRef, keptRows: judgedRows.positions, lastNames: named });
          if (tabled.kind === 'sentences' || tabled.kind === 'table') {
            standing = withPointer(tabled, tableSchema.shape.pointer.parse(args['pointer']));
            onLastCall = isLast;
          } else standing ??= tabled.kind === 'noDescription' || tabled.kind === 'unsupported' ? tabled : undefined;
          // an answer the checks accepted whole ends the run: the model has nothing more to say that is shown
          if ((tabled.kind === 'sentences' || tabled.kind === 'table') && judgedRows.removed === 0 && !judgedRows.verdictFound) control.stop = true;
          return feedback({ kept: judgedRows.kept.length, removed: judgedRows.removed, verdictFound: judgedRows.verdictFound, rejected: judgedRows.rejected });
        }
        const parsed = answerSchema.parse(args);
        const named = parsed.noDescription === undefined ? undefined : undescribedNamesOf(parsed.noDescription, basis.typeLines);
        const sentences: readonly SummarySentence[] = parsed.sentences.map((sentence) => ({ text: sentence.text, cites: sentence.cites }));
        const checked = await options.checks.run(judgeCheck, { sentences: withElementsOfNotes(sentences, basis.noteElements), text: basis.checkedText }, { timeoutMs: settings.timeoutMs, signal });
        if (checked.status === 'refused') return 'The answer could not be checked. Reply "Done."';
        const judged = checked.value;
        const outcome = outcomeOfDraft({ drafted: { status: 'drafted', sentences: judged.kept, removed: judged.removed, calls: 0, verdictFound: judged.verdictFound, model: modelRef, ...(named === undefined ? {} : { noDescription: noDescriptionSentence(named) }) }, basis, input: { reads, scope }, modelRef, keptRows: [], lastNames: named });
        if (outcome.kind === 'sentences' || outcome.kind === 'table') {
          standing = withPointer(outcome, parsed.pointer);
          onLastCall = isLast;
        }
        else standing ??= outcome.kind === 'noDescription' || outcome.kind === 'unsupported' ? outcome : undefined;
        // an answer the checks accepted whole ends the run: the model has nothing more to say that is shown, so no call acknowledges it
        if ((outcome.kind === 'sentences' || outcome.kind === 'table') && judged.removed === 0 && !judged.verdictFound) control.stop = true;
        return feedback({ kept: judged.kept.length, removed: judged.removed, verdictFound: judged.verdictFound, rejected: judged.rejected });
      },
    });

    const earlier: string[] = [];
    if (input.resume !== undefined) {
      const { resume } = input;
      // a first read that was heavy left no step behind: the plan holds one at least
      steps = resume.steps.length === 0 ? 0 : resume.counters.steps;
      // the earlier reads are made again through the gate, as of now: their results were never kept
      noteReplaying(true);
      try {
        for (const before of resume.steps) {
          if (scope.request.signal.aborted) throw new Error('the request was cancelled');
          if (input.deadline.aborted) return { kind: 'limit', limit: 'time', reads: entries };
          const tool = registry.find(before.tool);
          if (tool === undefined || !tool.available) {
            put(readNotRead(tool?.kind ?? 'intent', before.tool));
            earlier.push(`${before.tool}: not read, it is not available now`);
            continue;
          }
          if (tool.kind === 'ai-summary') {
            // a summary costs model calls and may differ: it is not drafted again after a wait
            put(readNotRead('ai-summary', 'ai-summary'));
            earlier.push('ai-summary: not read, it is not drafted again after a wait');
            continue;
          }
          const replayed = await runToolStep({ tool, values: before.values }, readScope, { continuing: before.confirmed === true });
          if (replayed.status === 'heavy') {
            // a read that has grown past what Ask reads at once since it was read: it is not read, and a decision never leads to another
            put(readNotRead(tool.kind, tool.name));
            earlier.push(`${tool.name}: not read, it is larger than one read now`);
            done.push({ tool: tool.name, values: before.values });
            continue;
          }
          if ('rows' in replayed) rows += replayed.rows;
          apply(tool, before.values, replayed, before.confirmed === true);
          if (ended !== undefined) return ended;
        }
      } finally {
        noteReplaying(false);
      }
      const waited = registry.find(resume.wait.tool);
      if (waited === undefined || !waited.available) {
        put(readNotRead(waited?.kind ?? 'intent', resume.wait.tool));
        earlier.push(`${resume.wait.tool}: not read, it is not available now`);
      } else if (resume.decision === 'skip') {
        put(readNotRead(waited.kind, resume.wait.tool));
        earlier.push(`${resume.wait.tool}: skipped by the analyst`);
      } else {
        // every limit is checked again before the heavy step is read: a decision never lifts one
        if (input.deadline.aborted) return { kind: 'limit', limit: 'time', reads: entries };
        if (input.callsUsed + control.calls + 1 >= settings.maxCalls) return { kind: 'limit', limit: 'calls', reads: entries };
        if (estimateTokens(system, `Question:\n${input.message}\n\nResults so far:\n${render()}`) > settings.maxInputTokens) return { kind: 'limit', limit: 'input', reads: entries };
        if (steps >= settings.maxSteps || (settings.rowsAllowed !== undefined && rows >= settings.rowsAllowed)) {
          limited = steps >= settings.maxSteps ? 'steps' : 'rows';
          control.answerOnly = true;
          earlier.push(`${waited.name}: not read, the turn has reached its limit`);
          put(readNotRead(waited.kind, waited.name));
        } else {
          const confirmed = await runToolStep({ tool: waited, values: resume.wait.values }, readScope, { continuing: true });
          steps += 1;
          if ('rows' in confirmed) rows += confirmed.rows;
          apply(waited, resume.wait.values, confirmed, true);
          if (ended !== undefined) return ended;
        }
      }
    }
    const user = `${input.context === undefined ? '' : `${input.context}\n\n`}Question:\n${input.message}${input.resume === undefined ? '' : `\n\nResults so far (the analyst has decided on the step that waited):\n${render()}${earlier.map((line) => `\n${line}`).join('')}`}`;
    if (estimateTokens(system, user) > settings.maxInputTokens) return { kind: 'limit', limit: 'input', reads: entries };
    const allowedCalls = settings.maxCalls - input.callsUsed;
    if (allowedCalls < 1) return { kind: 'limit', limit: 'calls', reads: entries };
    const beforeCall = (request: { readonly system: string; readonly messages: readonly string[]; readonly tools: string }): boolean => estimateTokens(request.system, `${request.messages.join('\n')}\n${request.tools}`) <= settings.maxInputTokens;
    try {
      const ran = await runAgent({ model, system, user, tools, control, maxCalls: allowedCalls, finalTool: ANSWER_TOOL, signal, beforeCall, onTrim: takeBack });
      options.onRun?.(ran);
      if (ran.refused || ran.trimmed) limited ??= 'input';
      // an answer is marked with the call limit only when the limit cut the reading short; one given on the last call with no read wanted is not
      else if (ran.reserveRefused) limited ??= 'calls';
    } catch (error) {
      if (error instanceof AuditUnavailableError || (error instanceof Error && 'code' in error && error.code === 'AUDIT_UNAVAILABLE')) throw error;
      else if (scope.request.signal.aborted) throw new Error('the request was cancelled');
      else if (input.deadline.aborted) return { kind: 'limit', limit: 'time', reads: entries };
      // a model call that fails after an answer stands (the one that only acknowledges it) never takes the answer away
      else if (!(error instanceof AuditedModelFailure)) throw error;
      else if (standing === undefined) return { kind: 'failed', why: failureOf(error.code) };
    }
    const modelCalls = control.calls + control.extra;
    if (ended !== undefined) return ended;
    const found = standing;
    const stoppedAt = limited === undefined ? {} : { stoppedAt: limited };
    const lastCall = onLastCall && limited === undefined ? { lastCallNote: ASSISTANT_LAST_CALL_SENTENCE } : {};
    if (found?.kind === 'sentences') return { kind: 'sentences', answer: { ...found, ...lastCall }, steps: Math.max(1, steps), calls: input.callsUsed + modelCalls, reads: entries, ...stoppedAt, ...(askAnswer === undefined ? {} : { askAnswer }) };
    if (found?.kind === 'table') return { kind: 'table', answer: { ...found, ...lastCall }, steps: Math.max(1, steps), calls: input.callsUsed + modelCalls, reads: entries, ...stoppedAt };
    if (found?.kind === 'noDescription') return { kind: 'no-description', sentence: found.sentence, names: found.names, calls: input.callsUsed + modelCalls };
    if (found?.kind === 'unsupported') return { kind: 'unsupported' };
    if (limited !== undefined) return { kind: 'limit', limit: limited, reads: entries };
    if (input.deadline.aborted) return { kind: 'limit', limit: 'time', reads: entries };
    if (modelCalls >= allowedCalls) return { kind: 'limit', limit: 'calls', reads: entries };
    return { kind: 'unsupported' };
  };
}
