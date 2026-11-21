import { ASSISTANT_VIEW_KEYS_MAX, readViewKeys, type AssistantFailureKind, type ElementRefs, type AssistantTurnAnswer, type ExtensionRequest, type SummaryReading, type TypeDescriptions } from '@neburyx/contracts';
import { AuditUnavailableError, type AuditedModelCall, type CheckRunner, type Judged, type FailureCode, type GateClient } from '@neburyx/ee-ai-runtime';
import { prepareSummary } from '../case-summary/prepare.js';
import type { AssembledText } from '../case-summary/assemble.js';
import { citationsOf, retrievalLine, summaryLine } from '../case-summary/coverage.js';
import { ASSISTANT_TABLE_ROWS_MAX } from '@neburyx/contracts';
import { judgeTableRows, rowsPhrase, subjectPluralOf, subjectTypeOf, TABLE_NOTE, typeOfKey } from './table.js';
import { draftSummary, type DraftedOrAlternative } from '../case-summary/draft.js';
import { checkedTextOf, judgeCheck } from '../case-summary/judge.js';
import { MAX_SUMMARY_SENTENCES } from '../case-summary/instructions.js';
import { rejudge, type KeptSentence } from '../case-summary/rejudge.js';
import { canonicalText } from '../questions/canonical.js';
import { selectedSectionOf } from './selected-section.js';
import type { SummaryAttachment } from './summary-attachment.js';
import { auditInvestigationOf } from '../case-summary/summarizer.js';
import { buildViewToolInstructions } from './step-instructions.js';
import type { ToolRegistry } from './tool-registry.js';
import { descriptionCitationsOf, noDescriptionReplyOf, noDescriptionSentence, typeLinesOf, undescribedNamesOf, undescribedOf, withTypeLines } from './type-lines.js';
import { readToolRequest, type ToolRequest } from './tool-request.js';
import { noteModelAnswer, notePropertyValuesSent, startModelCall } from './turn-audit.js';
import type { ViewInstructions } from './view-instructions.js';

export const VIEW_PROMPT_ID = 'assistant.view';
export const VIEW_PROMPT_VERSION = 8;
/** The version of the view prompt that carries the tools and the tool request as a third reply form. */
export const VIEW_TOOLS_PROMPT_VERSION = 9;
const VIEW_AUDIT_ACTION = 'assistant.view';

interface ViewAnswerSettings {
  readonly model: string;
  readonly maxInputTokens: number;
  readonly maxCalls: number;
  readonly totalTimeoutMs: number;
  readonly timeoutMs: number;
}

/** The prompt an answer from the view is sent under, when it is not the view's own: the overview beside a verdict refusal is one. */
interface ViewPrompt {
  readonly id: string;
  readonly version: number;
  readonly action: string;
  /** Keeps only the sentences that rest on a relationship of the view: what is connected, never what a node's properties say. */
  readonly connectionsOnly?: boolean;
}

export interface ViewAnswerOptions {
  readonly model: AuditedModelCall;
  readonly prompt?: ViewPrompt;
  readonly instructions: () => ViewInstructions | undefined;
  readonly checks: CheckRunner;
  readonly settings: () => ViewAnswerSettings | undefined;
  readonly now?: () => number;
}

/** What the module has reached, kept up to date as it goes so that a turn that ends in a throw still knows how far it got. */
export interface ViewProgress {
  calls: number;
  read: number;
  /** Whether the read of the elements was begun, which is not the same as having read any. */
  readStarted: boolean;
}

export interface ViewInput {
  readonly sourceId: string;
  readonly investigationId: string;
  readonly mask: boolean;
  readonly message: string;
  readonly viewElementKeys: readonly string[];
  readonly actorId: string;
  readonly actorRole: ExtensionRequest['principalRole'];
  readonly traceId: string;
  readonly readElements: NonNullable<GateClient['readElements']>;
  readonly signal: AbortSignal;
  /** Aborts when the time of the whole turn is spent; the router was given it too. */
  readonly deadline: AbortSignal;
  readonly callsUsed: number;
  readonly startedAt: number;
  readonly progress: ViewProgress;
  /** The reads the model may ask for instead of answering; absent, the view call has the two reply forms it always had. */
  readonly tools?: ToolRegistry;
  /** A summary attached to the turn: its sentences that still hold are given to the model beside the elements. */
  readonly summary?: SummaryAttachment;
  /** What the router was given of the person's earlier turns of the thread (references and titles only, read again through the gate): so that a follow-up such as "what does it mean" can be placed. Never a source of the checks. */
  readonly context?: string;
  /** What the mapping says the types of the source mean; the ones that matter to this call reach it as `m` lines. Absent, the values are as they were. */
  readonly typeDescriptions?: TypeDescriptions;
  /** The names of types the router said the message also asks the meaning of. */
  readonly askedTypes?: readonly string[];
  /** The form of the answer the router chose: `table` only when its reply said so. */
  readonly form?: 'table';
  /** The entity types of the elements the router context lists. */
  readonly contextTypes?: readonly string[];
  /** The keys of the elements the person has selected on the canvas, all of them keys of the view: the call is told which of its elements they are. */
  readonly selection?: readonly string[];
  /** Told when the call that writes the answer is about to be made, so a streamed turn can say so. */
  readonly onAnswering?: () => void;
  /** Told when the elements are about to be read, which is after every check that needs no read. */
  readonly onReading?: () => void;
}

type StoppedBecause = 'deadline' | 'input' | 'calls';

/** What the answer came to, with what was reached: the answer calls made, the elements read, the model of the accepted reply and how many elements the sentences cite. */
type ViewResult =
  | { readonly status: 'answered'; readonly answer: Extract<AssistantTurnAnswer, { status: 'answered'; route: 'view' }>; readonly cited: number }
  | { readonly status: 'unsupported' }
  /** The question is about types the mapping does not describe: the fixed sentence the server wrote from the names of the profile. */
  | { readonly status: 'no-description'; readonly sentence: string; readonly names: readonly string[] }
  /** The model asked for a read instead of answering: the loop goes on from this reading, with the request as its first step. */
  | { readonly status: 'tool'; readonly request: ToolRequest; readonly reading: SummaryReading; readonly assembled: AssembledText }
  | { readonly status: 'invalid-keys' }
  | { readonly status: 'summary-invalid' }
  | { readonly status: 'failed'; readonly kind: AssistantFailureKind }
  | { readonly status: 'stopped'; readonly because: StoppedBecause }
  | { readonly status: 'cancelled' };

export type ViewOutcome = ViewResult & { readonly calls: number; readonly read: number; readonly readStarted: boolean; readonly summary?: { readonly kept: number; readonly dropped: number } };

const kindOf = (code: FailureCode): AssistantFailureKind => (code === 'timeout' ? 'timeout' : code === 'rate-limited' ? 'rate-limit' : 'service');

/** The earlier turns of the thread as the router was given them, beside the elements: context for the question, never an element the sentences may cite. */
const contextSectionOf = (context: string | undefined): string => (context === undefined ? '' : `\n\nEarlier turns of this conversation, given only so that the question can be placed (their keys, such as c1, are not elements in view and are never cited):\n${context}`);

const valuesOf = (message: string, text: string, summary: string): string => `Question:\n${message}\n\nElements in view:\n${text}${summary}`;

/** The sentences of the attached summary that still hold, with the keys of this turn's text: model-written context beside the elements, never a source of the checks. */
const summarySectionOf = (kept: readonly KeptSentence[]): string => (kept.length === 0 ? '' : `\n\nSentences of an AI case summary of this investigation, written earlier by a model (each lists the keys of the elements it rests on):\n${kept.map((sentence) => `s${sentence.position}: ${sentence.text} (keys: ${sentence.cites.join(', ')})`).join('\n')}`);

/** The key of a sentence of the attached summary as the model cites it: `s2`. */
const SENTENCE_KEY = /^s(\d+)$/;
const KEY_PART = String.raw`(?<![\p{L}\p{N}_-])[nesm]\d+(?![\p{L}\p{N}_-])`;
/** A group of keys in brackets, alone or in a list: `(s1)`, `[s1, n4]`, `(s1 and s2)`; a key in a longer id, such as `DEV-s12`, is not one. */
const KEY_GROUP = new RegExp(String.raw`\s*[(\[]\s*${KEY_PART}(?:\s*(?:,|;|and|&)\s*${KEY_PART})*\s*[)\]]`, 'gu');
/** A sentence key anywhere else in the text, which stands in the grammar for a name and so removes the sentence. */
const BARE_SENTENCE_KEY = /(?<![\p{L}\p{N}_-])s\d+(?![\p{L}\p{N}_-])/u;

/** The text without the sentence keys of its bracketed groups: `(s1, n4)` becomes `(n4)` and `(s1 and s2)` nothing; a group that holds no sentence key is left for the checks of the element keys. */
function withoutSentenceKeys(text: string): string {
  return text.replace(KEY_GROUP, (group) => {
    const keys = group.match(new RegExp(KEY_PART, 'gu')) ?? [];
    if (!keys.some((key) => key.startsWith('s'))) return group;
    const elements = keys.filter((key) => !key.startsWith('s'));
    return elements.length === 0 ? '' : ` (${elements.join(', ')})`;
  });
}

/** "Cites the summary's sentence 1." as the server writes it, from the positions of the sentences used. */
const citedLineOf = (positions: readonly number[]): string => (positions.length === 1 ? `Cites the summary's sentence ${positions[0]}.` : `Cites the summary's sentences ${positions.slice(0, -1).join(', ')} and ${positions.at(-1)}.`);

const refCount = (refs: ElementRefs): number => refs.entities.length + refs.edges.length + refs.aggregates.length + refs.derived.length;

/** The references of the view and the ones only the summary cites, each once. */
function merged(view: ElementRefs, extra: ElementRefs): ElementRefs {
  const added = onlyNew(view, extra);
  return { entities: [...view.entities, ...added.entities], edges: [...view.edges, ...added.edges], aggregates: [...view.aggregates, ...added.aggregates], derived: [...view.derived, ...added.derived] };
}

/** The references of `extra` that `view` does not hold already. */
function onlyNew(view: ElementRefs, extra: ElementRefs): ElementRefs {
  const seen = new Set([...view.entities, ...view.edges, ...view.aggregates, ...view.derived].map((ref) => canonicalText(ref)));
  const fresh = <T extends object>(refs: readonly T[]): T[] => refs.filter((ref) => !seen.has(canonicalText(ref)));
  return { entities: fresh(extra.entities), edges: fresh(extra.edges), aggregates: fresh(extra.aggregates), derived: fresh(extra.derived) };
}

/** What both reads gave, once each: the counts around the reading stay those of the first read, the view's. */
function combined(view: SummaryReading, extra: SummaryReading): SummaryReading {
  const held = new Set([...view.nodes.map((node) => canonicalText(node.ref)), ...view.edges.map((edge) => canonicalText(edge.ref))]);
  return { ...view, nodes: [...view.nodes, ...extra.nodes.filter((node) => !held.has(canonicalText(node.ref)))], edges: [...view.edges, ...extra.edges.filter((edge) => !held.has(canonicalText(edge.ref)))] };
}

/** The two lines of coverage; with a summary attached they count the elements in view only, so that the elements only the summary cites are not shown as shown. */
function coverageOf(viewReading: SummaryReading, sentences: Parameters<typeof summaryLine>[0], attached: { readonly inView: ReadonlySet<string>; readonly assembled: AssembledText } | undefined): { readonly retrieval: string; readonly summary: string } {
  if (attached === undefined) return { retrieval: retrievalLine(viewReading), summary: summaryLine(sentences, viewReading) };
  const viewKeys = new Set([...attached.assembled.keys].filter(([, element]) => attached.inView.has(canonicalText(element.ref))).map(([key]) => key));
  return { retrieval: retrievalLine(viewReading), summary: summaryLine(sentences.map((sentence) => ({ ...sentence, cites: sentence.cites.filter((key) => viewKeys.has(key)) })), viewReading) };
}

const DEADLINE = new Error('the time of the turn is spent');

/** Settles with the promise, or rejects when the signal aborts first; the promise it leaves behind is left to finish unobserved. */
function until<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  work.catch(() => undefined);
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(DEADLINE);
    if (signal.aborted) abort();
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Answers one message from the elements in view: the keys are read back into references, read again through the gate, put to the model within the budget and the time of the turn and checked; what is left is the answer. */
export function createViewAnswer(options: ViewAnswerOptions): (input: ViewInput) => Promise<ViewOutcome> {
  const now = options.now ?? Date.now;
  return async (input) => {
    const { progress } = input;
    let counts: { readonly kept: number; readonly dropped: number } | undefined;
    const outcome = (rest: ViewResult): ViewOutcome => ({ ...rest, calls: progress.calls, read: progress.read, readStarted: progress.readStarted, ...(counts === undefined ? {} : { summary: counts }) });
    const instructions = options.instructions();
    const settings = options.settings();
    const promptId = options.prompt?.id ?? VIEW_PROMPT_ID;
    const auditAction = options.prompt?.action ?? VIEW_AUDIT_ACTION;
    if (instructions === undefined || settings === undefined) return outcome({ status: 'failed', kind: 'service' });
    const keys = readViewKeys(input.viewElementKeys, input.sourceId);
    if (!keys.ok) return outcome({ status: 'invalid-keys' });
    const { entities, edges, aggregates, derived } = keys.refs;
    if (entities.length + edges.length + aggregates.length + derived.length === 0) return outcome({ status: 'unsupported' });
    const wanted = input.summary === undefined ? keys.refs : merged(keys.refs, input.summary.refs);
    // the elements of the view and of the summary together stay within the cap of a view, or nothing is read
    if (wanted.entities.length + wanted.edges.length + wanted.aggregates.length + wanted.derived.length > ASSISTANT_VIEW_KEYS_MAX) return outcome({ status: 'stopped', because: 'input' });
    const remaining = input.startedAt + settings.totalTimeoutMs - now();
    if (remaining <= 0 || input.deadline.aborted) return outcome({ status: 'stopped', because: 'deadline' });
    if (input.signal.aborted) return outcome({ status: 'cancelled' });
    // an answer under a prompt of its own (the overview beside a refusal) reads nothing when it has no call to make
    if (options.prompt !== undefined && settings.maxCalls - input.callsUsed < 1) return outcome({ status: 'stopped', because: 'calls' });
    const turnSignal = AbortSignal.any([input.signal, input.deadline]);
    const ended = (): ViewOutcome | undefined => (input.signal.aborted ? outcome({ status: 'cancelled' }) : input.deadline.aborted ? outcome({ status: 'stopped', because: 'deadline' }) : undefined);
    let viewReading: SummaryReading;
    let reading: SummaryReading;
    progress.readStarted = true;
    input.onReading?.();
    try {
      const scope = { investigationId: input.investigationId, sourceId: input.sourceId, mask: input.mask, signal: turnSignal };
      viewReading = await until(input.readElements(scope, keys.refs), turnSignal);
      if (viewReading.nodes.length + viewReading.edges.length === 0) return outcome({ status: 'unsupported' });
      // the elements only the summary cites are read apart, so that the counts of the view's coverage stay the view's own
      const apart = input.summary === undefined ? undefined : onlyNew(keys.refs, input.summary.refs);
      reading = apart === undefined || refCount(apart) === 0 ? viewReading : combined(viewReading, await until(input.readElements(scope, apart), turnSignal));
    } catch (error) {
      const stopped = ended();
      if (stopped === undefined) throw error;
      return stopped;
    }
    progress.read = reading.nodes.length + reading.edges.length;
    // an overview of connections has nothing to cite when no relationship is in view: no call is made for it
    if (options.prompt?.connectionsOnly === true && reading.edges.length === 0) return outcome({ status: 'unsupported' });
    const judgedSummary = input.summary === undefined ? undefined : rejudge(input.summary.payload, reading);
    const kept = (judgedSummary?.kept ?? []).slice(0, MAX_SUMMARY_SENTENCES);
    if (input.summary !== undefined) counts = { kept: kept.length, dropped: input.summary.payload.sentences.length - kept.length };
    if (input.summary !== undefined && kept.length === 0) return outcome({ status: 'summary-invalid' });
    const section = summarySectionOf(kept) + contextSectionOf(input.context);
    const inView = new Set([...keys.refs.entities, ...keys.refs.edges, ...keys.refs.aggregates, ...keys.refs.derived].map((ref) => canonicalText(ref)));
    const { tools } = input;
    const sent = tools === undefined ? instructions : buildViewToolInstructions(instructions, tools);
    const promptVersion = options.prompt?.version ?? (tools === undefined ? VIEW_PROMPT_VERSION : VIEW_TOOLS_PROMPT_VERSION);
    const prepared = prepareSummary(reading, sent.text + section, settings.maxInputTokens);
    if (!prepared.ready) return outcome({ status: 'stopped', because: 'input' });
    const { assembled } = prepared;
    const allowed = settings.maxCalls - input.callsUsed;
    if (allowed < 1) return outcome({ status: 'stopped', because: 'calls' });
    notePropertyValuesSent(assembled.carriesPropertyValues);
    const typeLines = typeLinesOf(input.typeDescriptions, assembled, input.message, input.askedTypes, input.contextTypes);
    const checkedText = withTypeLines(checkedTextOf(assembled), typeLines);
    input.onAnswering?.();
    const cited = new Set<number>();
    // the names of the last reply that named types without a description, for the answer when it is the one accepted
    let lastNames: readonly string[] | undefined;
    // the positions of the rows of a table reply that the last check kept
    let keptRows: readonly number[] = [];
    let drafted: DraftedOrAlternative;
    try {
      drafted = await draftSummary({
        call: options.model,
        context: { action: auditAction, actorId: input.actorId, actorRole: input.actorRole, traceId: input.traceId, ...auditInvestigationOf(input.investigationId), sourceId: input.sourceId },
        instructions: sent.text,
        values: valuesOf(input.message, assembled.text + typeLines.section + selectedSectionOf(input.selection, input.sourceId, assembled), section + (input.form === 'table' ? TABLE_NOTE : '')),
        prompt: { id: promptId, version: promptVersion },
        alternative: (text: string) => (tools !== undefined && readToolRequest(text, tools).ok) || noDescriptionReplyOf(text, typeLines) !== undefined,
        noDescription: (names: readonly string[]) => {
          const found = undescribedNamesOf(names, typeLines);
          lastNames = found;
          return found === undefined ? undefined : noDescriptionSentence(found);
        },
        maxInputTokens: settings.maxInputTokens,
        judge: async (sentences, signal, drafted) => {
          if (input.form === 'table') {
            // each row alone (see `judgeTableRows`); a row that cites a sentence of a summary or a line that says what a type means is removed unjudged
            const judged = await judgeTableRows({ rows: sentences, columns: drafted?.columns, checks: options.checks, judge: judgeCheck, text: checkedText, timeoutMs: settings.timeoutMs, signal, drop: (row) => row.cites.some((key) => SENTENCE_KEY.test(key) || /^m\d+$/.test(key)) });
            if ('refused' in judged) return { refused: judged.refused };
            keptRows = judged.positions;
            return { kept: judged.kept, removed: judged.removed, verdictFound: judged.verdictFound, keysStripped: judged.keysStripped, keysRemoved: judged.keysRemoved };
          }
          if (input.summary === undefined) {
            const checked = await options.checks.run(judgeCheck, { sentences, text: checkedText }, { timeoutMs: settings.timeoutMs, signal });
            return checked.status === 'refused' ? { refused: checked.reason } : checked.value;
          }
          // with a summary attached each sentence is judged alone, together, so that the sentences of the summary it cites stay known by the sentence that cites them
          cited.clear();
          const byKey = new Map(kept.map((sentence) => [`s${sentence.position}`, sentence]));
          const prepared = sentences.map((reply) => {
            const text = withoutSentenceKeys(reply.text);
            if (BARE_SENTENCE_KEY.test(text)) return undefined;
            const used = new Set<number>();
            const cites = new Set<string>();
            for (const key of reply.cites) {
              const summarySentence = SENTENCE_KEY.test(key) ? byKey.get(key) : undefined;
              if (summarySentence === undefined) cites.add(key);
              else {
                used.add(summarySentence.position);
                for (const own of summarySentence.cites) cites.add(own);
              }
            }
            return { sentence: { text, cites: [...cites] }, used };
          });
          const runs = await Promise.all(prepared.map((item) => (item === undefined ? undefined : options.checks.run(judgeCheck, { sentences: [item.sentence], text: checkedText }, { timeoutMs: settings.timeoutMs, signal }))));
          const keptSentences: Judged['kept'][number][] = [];
          let removed = 0;
          let verdictFound = false;
          let keysStripped = 0;
          let keysRemoved = 0;
          for (const [index, run] of runs.entries()) {
            if (run === undefined) {
              removed += 1;
              keysRemoved += 1;
              continue;
            }
            if (run.status === 'refused') return { refused: run.reason };
            keptSentences.push(...run.value.kept);
            removed += run.value.removed;
            verdictFound ||= run.value.verdictFound;
            keysStripped += run.value.keysStripped;
            keysRemoved += run.value.keysRemoved;
            if (run.value.kept.length > 0) for (const position of prepared[index]?.used ?? []) cited.add(position);
          }
          return { kept: keptSentences, removed, verdictFound, keysStripped, keysRemoved };
        },
        ...(input.form === undefined ? {} : { form: input.form }),
        maxCalls: allowed,
        repeats: 1,
        totalTimeoutMs: remaining,
        signal: turnSignal,
        now,
        onCall: (calls) => void (progress.calls = calls),
        trace: (call) => {
          const record = startModelCall({ modelRef: options.model.modelRef, promptId, promptVersion, instructionsSha256: sent.sha256, instructions: call.instructions, values: call.values });
          return {
            ...(record.runId === undefined ? {} : { runId: record.runId }),
            received: (answer) => {
              record.received(answer);
              noteModelAnswer({ ...(answer.status === 'ok' ? { model: answer.model } : {}), usage: answer.usage });
            },
            end: record.end,
          };
        },
      });
    } catch (error) {
      if (error instanceof AuditUnavailableError) throw error;
      // the provider may throw when the deadline aborts it; that is the deadline, not a failure of the service
      const stopped = ended();
      // any other throw, a check that could not run included, leaves no unchecked answer and no word of its cause
      return stopped ?? outcome({ status: 'failed', kind: 'service' });
    }
    switch (drafted.status) {
      case 'alternative': {
        const read = tools === undefined ? undefined : readToolRequest(drafted.text, tools);
        if (read?.ok === true) return outcome({ status: 'tool', request: read.request, reading, assembled });
        const asked = noDescriptionReplyOf(drafted.text, typeLines);
        if (asked === undefined) return outcome({ status: 'unsupported' });
        const alone = undescribedOf(asked, typeLines);
        return outcome({ status: 'no-description', sentence: noDescriptionSentence(alone), names: alone });
      }
      case 'tooLarge':
        return outcome({ status: 'stopped', because: 'input' });
      case 'timeLimit':
        return outcome({ status: 'stopped', because: 'deadline' });
      case 'failed':
        // a reply that never fit the format, after the one repeat, is the fixed not-answered turn
        return drafted.kind === 'format' ? outcome({ status: 'unsupported' }) : outcome({ status: 'failed', kind: kindOf(drafted.kind === 'rate-limited' ? 'rate-limited' : drafted.kind === 'timeout' ? 'timeout' : 'provider-error') });
      case 'drafted': {
        // the fixed sentence covers the types the model named and every type the message names that has no description, whatever the model wrote
        const fixed = undescribedOf(drafted.noDescription === undefined ? undefined : lastNames, typeLines);
        const sentences = options.prompt?.connectionsOnly === true ? drafted.sentences.filter((sentence) => sentence.cites.some((key) => assembled.keys.get(key)?.kind === 'relationship')) : drafted.sentences;
        if (sentences.length === 0 || drafted.verdictFound) return fixed.length > 0 ? outcome({ status: 'no-description', sentence: noDescriptionSentence(fixed), names: fixed }) : outcome({ status: 'unsupported' });
        if (drafted.table !== undefined) {
          const table = drafted.table;
          const rows = keptRows.flatMap((index) => (table.rows[index] === undefined ? [] : [table.rows[index]]));
          const shown = rows.slice(0, ASSISTANT_TABLE_ROWS_MAX);
          const cut = rows.length - shown.length;
          const shownSentences = shown.map((row) => ({ text: row.cells.join(' '), cites: [...row.cites] }));
          const elementCitations = [...citationsOf(shownSentences, assembled)];
          const subject = subjectTypeOf(shown, assembled);
          const plural = subjectPluralOf(subject, input.typeDescriptions);
          const inView = subject === undefined ? assembled.keys.size : [...assembled.keys.keys()].filter((key) => typeOfKey(assembled, key)?.text === subject.text).length;
          const answer = {
            status: 'answered' as const,
            route: 'view' as const,
            table: { title: `${plural} · ${rowsPhrase(shown.length)}`, columns: [...table.columns], rows: shown.map((row) => ({ cells: [...row.cells], cites: [...row.cites] })), ...(table.rows.length - rows.length > 0 ? { droppedRows: table.rows.length - rows.length } : {}), ...(cut > 0 ? { moreNotShown: cut } : {}) },
            citations: elementCitations,
            coverage: { retrieval: retrievalLine(viewReading), summary: `${shown.length} of ${inView} ${plural.toLowerCase()} in view shown · exact` },
            ...(fixed.length === 0 ? {} : { noDescription: noDescriptionSentence(fixed) }),
            model: drafted.model,
            calls: progress.calls + input.callsUsed,
          };
          return outcome({ status: 'answered', answer, cited: elementCitations.length });
        }
        const elementCitations = [...citationsOf(sentences, assembled)];
        const citations = [...elementCitations, ...descriptionCitationsOf(sentences, typeLines)];
        const positions = [...cited].sort((a, b) => a - b);
        const answer = { status: 'answered' as const, route: 'view' as const, sentences: [...sentences], ...(fixed.length === 0 ? {} : { noDescription: noDescriptionSentence(fixed) }), citations, coverage: { ...coverageOf(viewReading, sentences, input.summary === undefined ? undefined : { inView, assembled }), ...(cited.size === 0 ? {} : { summaryCited: citedLineOf(positions) }) }, ...(cited.size === 0 ? {} : { summarySentencesCited: positions }), model: drafted.model, calls: progress.calls + input.callsUsed };
        return outcome({ status: 'answered', answer, cited: elementCitations.length });
      }
      default: {
        const unreachable: never = drafted;
        return unreachable;
      }
    }
  };
}
