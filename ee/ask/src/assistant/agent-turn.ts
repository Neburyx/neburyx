import { z } from 'zod';
import { ASSISTANT_LAST_CALL_SENTENCE, ASSISTANT_POINTER_SENTENCES, ASSISTANT_POINTERS, type AskAnswer, type AssistantLimit, type AssistantPointer, type AssistantRead, type SummaryReading, type SummarySentence } from '@neburyx/contracts';
import { AuditedModelFailure, runAgent, type AgentChatModel, type AgentRun, type AgentControl, type AgentTool, type AuditedModelHook } from '@neburyx/ee-assistant-agent';
import { AuditUnavailableError, removalNoteOf, type AuditedCallContext, type CheckRunner, type RejectedSentence } from '@neburyx/ee-ai-runtime';
import { assembleText, estimateTokens, type AssembledText } from '../case-summary/assemble.js';
import { judgeCheck } from '../case-summary/judge.js';
import { OFFERED_LABEL_WORDS, judgeTableRows, refusedLabelNote, rowSentenceOf, withEndsCited } from './table.js';
import { combineOutcomes, type BlocksAnswer, type JudgedBlock } from './answer-blocks.js';
import { parseBlocksInput } from './blocks.js';
import { viewCoverageOf } from '../case-summary/coverage.js';
import { assembleResults, answerBasisOf, failureOf, outcomeOfDraft, typeNamesOf, withElementsOfNotes, type ReadDone, type ToolAnswerOutcome } from './tool-answer.js';
import { readNotRead, readOfAnswer, readOfNothing, readOfNotes, readOfSummary, readOfTypology, readOfView } from './reads.js';
import { afterReads, toolRegistryOf, type LoopOutcome, type ResumeState } from './turn-outcome.js';
import type { PlanStep } from './plan-token.js';
import type { Tool } from './tool-registry.js';
import { runToolStep, type StepResult, type StepScope } from './tool-step.js';
import { shareSteps, stepsOf } from './steps.js';
import { noDescriptionSentence, undescribedNamesOf } from './type-lines.js';
import { noteModelAnswer, noteTurn, notePropertyValuesSent, noteReplaying, startModelCall } from './turn-audit.js';
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
type RemovalFeedback = (outcome: { readonly kept: number; readonly removed: number; readonly verdictFound: boolean; readonly rejected: readonly RejectedSentence[]; readonly form?: RemovalForm; /** For an answer of several kinds of block: what was kept of each. */ readonly keptOf?: { readonly sentences: number; readonly items: number; readonly rows: number }; /** A list label was not shown. */ readonly labelRemoved?: boolean }) => string;

/** What the model is told to do with a removed sentence or row: the next answer replaces this one when any of its own is kept, so what is removed for a reason that can be mended is mended and sent again, and what no line can hold is left out. */
const RESEND_SENTENCES = 'Your next answer replaces this one if any of its sentences is kept: call answer again with every sentence you want shown, the kept ones and each removed one corrected as its reason says (copy a figure as the line writes it, with its label; cite every element a count or an all, each or latest sentence speaks of). Leave a sentence out when no line holds its figure, name or comparison, or when it states a conclusion; never add a cite only to keep it.';
const RESEND_TABLE = 'Your next answer replaces this one if any of its rows is kept: call answer again with the whole table, the kept rows and each removed row corrected as its reason says (a cell copies a figure of the lines its row cites, with its label). Leave a row out when no line holds its figure or name; never add a cite only to keep it.';
const VERDICT_LEFT_OUT = ' A sentence removed for verdict wording is left out, not reworded.';
const VERDICT_ROW_LEFT_OUT = ' A row removed for verdict wording is left out, not reworded.';

/** An answer of several kinds of block: the next answer replaces the whole of it, so it must hold every block again. */
const RESEND_BLOCKS = 'Your next answer replaces this whole answer if any of its sentences, items or rows is kept: call answer again with every block you want shown, each sentences block, list and table, the kept ones and each removed one corrected as its reason says (copy a figure as the line writes it, with its label; cite every element a count or an all, each or latest sentence speaks of; a cell copies a figure of the lines its row cites). Leave a sentence, an item or a row out when no line holds its figure, name or comparison; never add a cite only to keep it.';
const VERDICT_BLOCKS_LEFT_OUT = ' A sentence, an item or a row removed for verdict wording is left out, not reworded.';
const VERDICT_ITEM_LEFT_OUT = ' An item removed for verdict wording is left out, not reworded.';

type RemovalForm = 'sentences' | 'list' | 'table' | 'blocks';

const formOf = (inputs: readonly { readonly kind: 'sentences' | 'list' | 'table' }[]): RemovalForm => {
  const kinds = new Set(inputs.map((block) => block.kind));
  const only = [...kinds][0];
  return kinds.size === 1 && only !== undefined ? only : 'blocks';
};

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

const keptText = (kept: number, form: RemovalForm | undefined, keptOf: { readonly sentences: number; readonly items: number; readonly rows: number } | undefined): string => {
  if (form === 'blocks' && keptOf !== undefined) {
    const parts = [keptOf.sentences > 0 ? plural(keptOf.sentences, 'sentence', 'sentences') : undefined, keptOf.items > 0 ? plural(keptOf.items, 'item', 'items') : undefined, keptOf.rows > 0 ? plural(keptOf.rows, 'row', 'rows') : undefined].filter((part): part is string => part !== undefined);
    return parts.length === 0 ? '0 sentences' : parts.join(' and ');
  }
  return `${kept} ${form === 'table' ? 'rows' : form === 'list' ? 'items' : 'sentences'}`;
};

const LABEL_NOT_SHOWN = ' A list label was not shown: use one of the fixed headings ("Where it came from", "Details", "Notes") or plain words of the lines.';

const plainFeedback: RemovalFeedback = ({ kept, removed, verdictFound, rejected, form, keptOf, labelRemoved }) =>
  removed === 0
    ? `Checked: all ${keptText(kept, form, keptOf)} kept. Reply "${FINAL_TEXT}".`
    : `Checked: ${keptText(kept, form, keptOf)} kept, ${removed} removed${verdictFound ? ' (verdict wording found)' : ''}. ${form === 'blocks' ? RESEND_BLOCKS : form === 'table' ? RESEND_TABLE : RESEND_SENTENCES}${verdictFound ? (form === 'blocks' ? VERDICT_BLOCKS_LEFT_OUT : form === 'table' ? VERDICT_ROW_LEFT_OUT : form === 'list' ? VERDICT_ITEM_LEFT_OUT : VERDICT_LEFT_OUT) : ''}${labelRemoved === true ? LABEL_NOT_SHOWN : ''} Or reply "${FINAL_TEXT}" to leave the answer as it stands.${rejected.length === 0 ? '' : `\n${removalNoteOf(rejected)}`}`;

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

type Standing = BlocksAnswer | Extract<ToolAnswerOutcome, { kind: 'noDescription' | 'unsupported' }>;

const noDescriptionSchema = z.array(z.string()).optional();
const pointerSchema = z.enum(ASSISTANT_POINTERS).optional();
/** The fixed sentence of the pointer the model named, on an answer that stands: the model never writes it. */
const withPointer = (answer: BlocksAnswer, pointer: AssistantPointer | undefined): BlocksAnswer => (pointer === undefined ? answer : { ...answer, pointer: ASSISTANT_POINTER_SENTENCES[pointer] });
/** The input the model is offered for `answer`: the blocks are checked one by one in the call, so that an input that is not valid gets the tool's own fixed result and not a schema error. */
const answerSchema = z.object({ blocks: z.array(z.record(z.string(), z.unknown())).min(1), noDescription: noDescriptionSchema, pointer: pointerSchema });
/** The fixed result of an answer made while the elements on screen were never looked at and no read of the source gave an element. */
export const READ_VIEW_FIRST = 'Not judged: you have read no element yet, and the view holds the elements on screen. Call view, then call answer again.';
const NOT_VALID = 'The answer is not valid: give one to four blocks, each { kind: "sentences", sentences: [{ text, cites }] }, { kind: "list", label (optional, at most 40 characters), items: [{ text, cites }] } (one to twelve items) or, when a table was asked for, { kind: "table", columns, rows: [{ cells, cites }] }, within the bounds. Call answer again.';

/** What the model is told of the `answer` tool: the shapes of its blocks and their bounds; a table only when one was asked for. */
export const answerDescription = (tableAsked: boolean): string =>
  `Give the final answer as blocks, in the order you want them shown: { kind: "sentences", sentences: [{ text, cites }] } for short sentences, each with the keys of the elements it rests on in cites, { kind: "list", label, items: [{ text, cites }] } for a short list of one to twelve items cited the same way (the label is optional: \"Where it came from\", \"Details\", \"Notes\" or plain words of the lines you were given, at most 40 characters)${tableAsked ? `, and { kind: "table", columns, rows: [{ cells, cites }] } for the table that was asked for: one row for each element, with the row\'s own values in cells and the keys of the elements it rests on in cites. A column label is words of the property names and types in the lines, or of these words: ${OFFERED_LABEL_WORDS.join(', ')}. A table that answers which elements are connected to an element has a row for every connected element the lines you were given hold, in the order of the lines and never a sample you choose, up to 100 rows` : ''}. A list that answers which elements are connected to an element has an item for every connected element the lines you were given hold, in the order of the lines and never a sample you choose, as many as it may hold; the server says how many are not shown. At most four blocks. Call it once when you have what you need.`;

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
    let viewAsked = false;
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
    const system = `${rules}\n\n${source === undefined ? '' : `# This source's questions\n\n${source.classification.text}\n\n`}# How you work\n\nYou are an investigator's assistant. You read only through the tools you were given, and every read goes through the gate. Read what you need, then call answer once. The words this, these, here and on screen mean the elements of the view: call view before you say which element a message means, what is or is not on screen, or that nothing is identified. You cannot change the canvas: for a message that asks to expand, add or draw something, read what it asks for with your tools, answer from what they return, and set the answer's pointer to canvas-expand (the server writes the sentence; never write it yourself). For a message that asks how many there are, read the degree preview of the element: its line states the connected elements by type with their quality; answer in plain words, for example \"<element title> has 169,756 <type name> (exact)\", keeping the figure and the quality as the line writes them, and cite both the element and the line, never a total no line states; the check removes any sentence that is not supported by the lines it cites. A message may ask for more than one thing, for example how many of one kind are in view and how many relationships an element has: answer every part, each in a sentence of its own. State a count as a number with its quality as the line that states it writes it; the number of element lines of one type in the view is a count you may state from the view itself. A relationship line may hold "members: <count>": the number of relationships of the source that the one line stands for, between its two ends. Never write the word members, and state that figure only when the message asks how many relationships there are, calling them relationships and keeping the quality as the line writes it. A part that no line supports, such as a count no line states, gets a sentence that says plainly that it is not yet retrieved, and that sentence cites the line that shows what is missing; a part is never left out. A sentence that says what the lines do not show cites the elements or the read line it speaks of, and only those. A sentence that says the view holds no relationship (or no element of some kind), or what the view does not show, cites the line c1, the coverage of the view: how many entities and relationships it shows and what is not yet retrieved; a sentence about what a read did not return cites that read's own line, and states only what that line says. Never cite a key only to keep a sentence: a sentence that cites nothing is removed, and that part goes unanswered. The view holds only the relationships drawn on the canvas (its Relationships lines): a question about who or what an element is connected to, in either direction, that those lines do not answer is answered by reading that element's neighbours with expand or linked-entities before you say it is not shown, and when it needs more reads than the steps allow, say plainly what was not read. When a question asks for the element with the largest, the latest or the first value among some others and also what it is connected to (for example: which of the elements has the largest value, and what is it connected to), find that element in the lines, then take the second step: read the neighbours of that element (expand or linked-entities) before you say the rest is not shown, within the steps allowed. The line c1 never replaces a read: a question about who or what an element is connected to that the Relationships lines do not answer is answered by reading its neighbours, and a sentence that the view shows no relationship is no answer to it. A question about whether several elements share something at their other end (the same other end, group or value), however it is worded (they may be asked to share the other side, the same source or the same target), is never answered from the view alone. When there are more such elements than the steps allow, read a bounded sample within the steps (the neighbours of up to three elements, picked by a rule you state, such as the largest or the first listed; for example shared-attribute from one of them, with the type at its other end and the relationship to it, lists the elements that share that other end: say which of those are on screen), answer only for that sample: name the elements you read and state what each read returned in a sentence of its own, copying its figure, label and quality, and citing its read line (for example \"The read of the neighbours of X returned 2 matches (exact)\"); one read is anchored on one element and shows what that element has in common with others, not between every pair of the sample, and you say that none share only when complete reads show it, within the type and relationship you read, and say plainly what was not read and why, in words with no number you computed, citing the line c1 (\"the other elements were not read: one read each, more than this turn allows\"; a figure such as 22 that no line holds is removed by the check); never say \"not shown\" for what you did not read, and never generalise from the sample to the rest. State a figure of a line (a count, or what is not yet retrieved) exactly as that line writes it, with its label: copy \"≥ 1,000 not yet retrieved (lower bound)\" as written, never \"more than 1,000\". When a sentence says how many, it cites every element it counts in that same sentence. A sentence that says all, each, every or "the ... on screen", or that compares (the latest, the largest, the most), cites every element it speaks of in that same sentence, as a count does; when only some are cited, say "some" or name them. A sentence that ranks (the largest, smallest, earliest or latest value of a property, or the most or the fewest of a named property) names the property once, makes one ranking assertion, cites every element of that type it ranks over, and writes a compound ranking as separate sentences. When one read listed some of the elements of a type and you rank among those only, write the sentence as "Among the <type name, plural> in the read, <element> has the largest <property>, <value>.": over one read only, citing every element that read listed and that read's line, with nothing after "in the read" that names the read; say which read it was by citing its line or in a separate sentence, and say nothing beyond that read. A question for the largest, smallest, latest or earliest among elements that no line holds yet is answered by reading them first, with an intent or expand of the element in view that lists them, then ranking within one read in that form. Such a ranking is among those the read listed: when a read is paged, filtered or a lower bound, never say or imply that it holds for all of them. Say that they cannot be ranked only when no read lists them or no step is left. Name a link between two elements only when a relationship line you cite holds it: never write that an element is "for" or "of" another, or that one sent to or received from another, unless a cited relationship line says so. After answer, reply "${FINAL_TEXT}" and nothing else.`;

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
    /** Whether the answer comes before any element was looked at while the view holds some: refused once, when a read and an answer after it still fit. Notes, a summary and a typology are no read of the source. */
    const mustReadViewFirst = (): boolean =>
      readable.some((tool) => tool.kind === 'view') &&
      !done.some((step) => registry.find(step.tool)?.kind === 'view') &&
      !reads.some((read) => read.result !== undefined && assembleResults([read]).assembled.keys.size > 0) &&
      limited === undefined &&
      steps < settings.maxSteps &&
      (settings.rowsAllowed === undefined || rows < settings.rowsAllowed) &&
      settings.maxCalls - input.callsUsed - control.calls - control.extra >= 2;
    /** What each read of the turn returned to the model: with the message and its context, everything of the source and the person that the model holds. */
    const readResults: string[] = [];
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
        readResults.push(text);
        return text;
      },
    }));
    tools.push({
      name: ANSWER_TOOL,
      description: answerDescription(scope.form === 'table'),
      schema: answerSchema,
      run: async (args) => {
        if (!viewAsked && mustReadViewFirst()) {
          viewAsked = true;
          return READ_VIEW_FIRST;
        }
        stepsOf(scope.request).answering();
        // an answer written on the last call the turn allows, where no read was offered: said so in a fixed sentence, whether the model was done or not
        const isLast = control.calls + control.extra + input.callsUsed >= settings.maxCalls;
        const basis = answerBasisOf({ reads, ...(view === undefined ? {} : { view }), scope, message: input.message });
        if (basis === undefined) return NOT_ANSWERED;
        const parsed = answerSchema.safeParse(args);
        const inputs = parsed.success ? parseBlocksInput(parsed.data.blocks, scope.form === 'table') : undefined;
        if (!parsed.success || inputs === undefined) return NOT_VALID;
        const named = parsed.data.noDescription === undefined ? undefined : undescribedNamesOf(parsed.data.noDescription, basis.typeLines);
        const judgedBlocks: JudgedBlock[] = [];
        let other: Extract<ToolAnswerOutcome, { kind: 'noDescription' | 'unsupported' }> | undefined;
        let kept = 0;
        let keptSentences = 0;
        let keptItems = 0;
        let listDropped = 0;
        let keptRows = 0;
        let removed = 0;
        let verdictFound = false;
        let droppedWithTable = 0;
        const citesAdded = new Map<string, number>();
        const labelNotes: string[] = [];
        const rejected: RejectedSentence[] = [];
        for (const block of inputs) {
          if (block.kind === 'table') {
            // a row that cites a relationship cites its ends too, so that a cell naming an end is judged against that end and the person sees it
            const wider = withEndsCited(block.draft.rows, basis.assembled);
            const draft = { ...block.draft, rows: wider.rows };
            for (const [row, count] of wider.added) citesAdded.set(JSON.stringify([row.cells, row.cites]), count);
            const labelNote = refusedLabelNote(draft.columns, basis.checkedText.text, [user, ...readResults]);
            if (labelNote !== undefined) labelNotes.push(labelNote);
            const judgedRows = await judgeTableRows({ rows: draft.rows.map(rowSentenceOf), columns: draft.columns, checks: options.checks, judge: judgeCheck, text: basis.checkedText, timeoutMs: settings.timeoutMs, signal, drop: (row) => row.cites.some((key) => !basis.assembled.keys.has(key)) });
            if ('refused' in judgedRows) return 'The answer could not be checked. Reply "Done."';
            kept += judgedRows.kept.length;
            keptRows += judgedRows.kept.length;
            rejected.push(...judgedRows.rejected);
            removed += judgedRows.removed + draft.uncited;
            verdictFound ||= judgedRows.verdictFound;
            const tabled = outcomeOfDraft({ drafted: { status: 'drafted', table: draft, sentences: judgedRows.kept, removed: judgedRows.removed, calls: 0, verdictFound: judgedRows.verdictFound, model: modelRef, ...(named === undefined ? {} : { noDescription: noDescriptionSentence(named) }) }, basis, input: { reads, scope }, modelRef, keptRows: judgedRows.positions, lastNames: named });
            if (tabled.kind === 'sentences' || tabled.kind === 'table') judgedBlocks.push(tabled);
            else {
              // a table with no row left is left out, and its rows are counted with those of the table that is shown
              droppedWithTable += draft.rows.length + draft.uncited;
              other ??= tabled.kind === 'noDescription' || tabled.kind === 'unsupported' ? tabled : undefined;
            }
            continue;
          }
          const texts = block.kind === 'list' ? block.items : block.sentences;
          const checked = await options.checks.run(judgeCheck, { sentences: withElementsOfNotes(texts, basis.noteElements), text: basis.checkedText }, { timeoutMs: settings.timeoutMs, signal });
          if (checked.status === 'refused') return 'The answer could not be checked. Reply "Done."';
          const judged = checked.value;
          kept += judged.kept.length;
          if (block.kind === 'list') {
            keptItems += judged.kept.length;
            listDropped += judged.removed;
          } else keptSentences += judged.kept.length;
          rejected.push(...judged.rejected);
          removed += judged.removed;
          verdictFound ||= judged.verdictFound;
          const outcome = outcomeOfDraft({ drafted: { status: 'drafted', sentences: judged.kept, removed: judged.removed, calls: 0, verdictFound: judged.verdictFound, model: modelRef, ...(named === undefined ? {} : { noDescription: noDescriptionSentence(named) }) }, basis, input: { reads, scope }, modelRef, keptRows: [], lastNames: named });
          if (outcome.kind === 'sentences' && block.kind === 'list') judgedBlocks.push({ ...outcome, list: true, ...(block.label === undefined ? {} : { label: block.label }) });
          else if (outcome.kind === 'sentences' || outcome.kind === 'table') judgedBlocks.push(outcome);
          else other ??= outcome.kind === 'noDescription' || outcome.kind === 'unsupported' ? outcome : undefined;
        }
        const combined = verdictFound ? undefined : combineOutcomes(judgedBlocks, basis, droppedWithTable);
        if (combined !== undefined) {
          standing = withPointer(combined, parsed.data.pointer);
          onLastCall = isLast;
          const tableCitesAdded = combined.blocks.flatMap((block) => (block.kind === 'table' ? block.table.rows : [])).reduce((sum, row) => sum + (citesAdded.get(JSON.stringify([row.cells, row.cites])) ?? 0), 0);
          noteTurn({ tableRowsLeftOut: combined.blocks.some((block) => block.kind === 'table') ? 0 : droppedWithTable, listItemsDropped: listDropped + combined.itemsCut, tableCitesAdded });
        }
        else standing ??= other;
        // an answer the checks accepted whole ends the run: the model has nothing more to say that is shown, so no call acknowledges it
        if (combined !== undefined && removed === 0 && combined.leftOut === 0 && combined.itemsCut === 0 && combined.labelsRemoved === 0 && !verdictFound) control.stop = true;
        const cutItems = combined?.itemsCut ?? 0;
        const told = feedback({ kept: kept - cutItems, removed: removed + (combined?.leftOut ?? 0) + (combined?.itemsCut ?? 0) + (combined?.labelsRemoved ?? 0), verdictFound, rejected, form: formOf(inputs), keptOf: { sentences: keptSentences, items: keptItems - cutItems, rows: keptRows }, ...((combined?.labelsRemoved ?? 0) > 0 ? { labelRemoved: true } : {}) });
        return [told, ...new Set(labelNotes)].join('\n');
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
    if (found !== undefined && 'blocks' in found) return { kind: 'blocks', answer: { ...found, ...lastCall }, steps: Math.max(1, steps), calls: input.callsUsed + modelCalls, reads: entries, ...stoppedAt, ...(askAnswer === undefined ? {} : { askAnswer }) };
    if (found?.kind === 'noDescription') return { kind: 'no-description', sentence: found.sentence, names: found.names, calls: input.callsUsed + modelCalls };
    if (found?.kind === 'unsupported') return { kind: 'unsupported' };
    if (limited !== undefined) return { kind: 'limit', limit: limited, reads: entries };
    if (input.deadline.aborted) return { kind: 'limit', limit: 'time', reads: entries };
    if (modelCalls >= allowedCalls) return { kind: 'limit', limit: 'calls', reads: entries };
    return { kind: 'unsupported' };
  };
}
