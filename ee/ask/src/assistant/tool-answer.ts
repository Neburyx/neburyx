import { ASSISTANT_CITATION_TITLE_MAX, type AskRunResult, type SummaryReading, type AssistantFailureKind, type AssistantTurnAnswer, type SummarySentence } from '@neburyx/contracts';
import { AuditUnavailableError, type AuditedModelCall, type CheckRunner } from '@neburyx/ee-ai-runtime';
import { type AssembledText, estimateTokens } from '../case-summary/assemble.js';
import { retrievalLine } from '../case-summary/coverage.js';
import { draftSummary, type DraftedOrAlternative } from '../case-summary/draft.js';
import { checkedTextOf, judgeCheck } from '../case-summary/judge.js';
import { auditInvestigationOf } from '../case-summary/summarizer.js';
import { listedElements } from '../summary/index.js';
import { coverageOf, inexactCountOf } from './coverage.js';
import { noteModelAnswer, startModelCall } from './turn-audit.js';
import type { NoteSentence, StepScope } from './tool-step.js';
import { descriptionCitationsOf, noDescriptionReplyOf, noDescriptionSentence, typeLinesOf, undescribedNamesOf, undescribedOf, withTypeLines } from './type-lines.js';
import { refId } from '../summary/title.js';
import type { ViewInstructions } from './view-instructions.js';

export const ANSWER_PROMPT_ID = 'assistant.answer';
export const ANSWER_PROMPT_VERSION = 5;
const ANSWER_AUDIT_ACTION = 'assistant.answer';

export interface ToolAnswerOptions {
  readonly model: AuditedModelCall;
  readonly instructions: () => ViewInstructions | undefined;
  readonly checks: CheckRunner;
  readonly timeoutMs: number;
  readonly totalTimeoutMs: number;
  readonly now?: () => number;
}

export interface ReadDone {
  readonly tool: string;
  /** The plain-words label of the intent that was read, when it has one: the reads text says `read of <label>`. */
  readonly label?: string;
  readonly result?: AskRunResult;
  /** The lines of the typology, for the read of that tool: operator text, which the answer may cite by the keys `t1`, `t2`, … */
  readonly typology?: readonly string[];
  /** The model-written sentences of an application read (the person's AI notes, or the AI case summary), with the elements each rests on, and how many entries of the notes were not read. */
  readonly written?: { readonly sentences: readonly NoteSentence[]; readonly notRead: number };
}

export interface ToolAnswerInput {
  readonly scope: StepScope;
  readonly message: string;
  /** The reads of the turn in order: the tool and what it returned, or nothing for a read that found nothing. */
  readonly reads: readonly ReadDone[];
  /** What the view showed, when the loop was entered from the view: its elements keep the keys the view call gave them. */
  readonly view?: { readonly assembled: AssembledText; readonly reading: SummaryReading };
  /** What the router was given of the person's earlier turns: context for the question, never an element that may be cited. */
  readonly context?: string;
  readonly steps: number;
  readonly callsUsed: number;
  readonly maxCalls: number;
  readonly maxInputTokens: number;
  readonly startedAt: number;
  readonly signal: AbortSignal;
  readonly deadline: AbortSignal;
}

export type ToolAnswerOutcome =
  | { readonly kind: 'sentences'; readonly sentences: readonly SummarySentence[]; readonly citations: Extract<AssistantTurnAnswer, { status: 'answered'; sentences: unknown }>['citations']; readonly coverage: { readonly retrieval: string; readonly summary: string }; readonly model: string; readonly calls: number; readonly noDescription?: string }
  /** The question is about types the mapping does not describe: the fixed sentence the server wrote and the names of the profile. */
  | { readonly kind: 'noDescription'; readonly sentence: string; readonly names: readonly string[]; readonly calls: number }
  | { readonly kind: 'unsupported'; readonly calls: number }
  | { readonly kind: 'limit'; readonly limit: 'calls' | 'time' | 'input'; readonly calls: number }
  | { readonly kind: 'failed'; readonly why: AssistantFailureKind; readonly calls: number };

type ElementKey = NonNullable<ReturnType<AssembledText['keys']['get']>>;

const failureOf = (kind: string): AssistantFailureKind => (kind === 'timeout' ? 'timeout' : kind === 'rate-limited' ? 'rate-limit' : 'service');

/** A bracketed group of keys, of which those that hold a note's sentence (`a`) are taken out of a sentence's text: the group goes when it holds nothing else, and keeps the other keys otherwise, so that the checks take them out as they take out the keys of elements. */
const KEY_GROUP_OF_TEXT = /\s*[(\[]\s*[nerastm]\d+(?:\s*(?:,|;|and|&)\s*[nerastm]\d+)*\s*[)\]]/gu;

const withoutNoteKeys = (text: string): string =>
  text.replace(KEY_GROUP_OF_TEXT, (group) => {
    const keys = group.match(/[nerastm]\d+/gu) ?? [];
    if (!keys.some((key) => key.startsWith('a'))) return group;
    const others = keys.filter((key) => !key.startsWith('a'));
    return others.length === 0 ? '' : ` (${others.join(', ')})`;
  });

/**
 * What an `a` key stands for in the checks: the keys of the elements its sentence rests on, as in the view call, so that the text of a note is never a source of a name, a figure or a claim; a key of a note the step did not return stays
 * and fails the check that every key was returned. A key written in a bracketed group is taken out of the text, and one written elsewhere is a name no line holds and removes the sentence.
 */
function withElementsOfNotes(sentences: readonly SummarySentence[], noteElements: ReadonlyMap<string, readonly string[]>): readonly SummarySentence[] {
  if (noteElements.size === 0) return sentences;
  return sentences.map((sentence) => {
    const cites = [...new Set(sentence.cites.flatMap((cite) => noteElements.get(cite) ?? [cite]))];
    return { text: withoutNoteKeys(sentence.text), cites };
  });
}

/** The title a citation carries: the element's own, cut to what the contract allows (its length in UTF-16 code units, as the schema counts it) without splitting a surrogate pair, and none when it is blank. */
export function citationTitleOf(title: string | undefined): string | undefined {
  if (title === undefined || title.trim() === '') return undefined;
  if (title.length <= ASSISTANT_CITATION_TITLE_MAX) return title;
  const cut = title.slice(0, ASSISTANT_CITATION_TITLE_MAX);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

const linesPhrase = (count: number): string => `${count} ${count === 1 ? 'line' : 'lines'}`;
const sentencesPhrase = (count: number): string => `${count} ${count === 1 ? 'sentence' : 'sentences'}`;
const findingOf = (read: ReadDone): string => (read.typology !== undefined ? linesPhrase(read.typology.length) : read.written !== undefined ? `${sentencesPhrase(read.written.sentences.length)}${read.written.notRead > 0 ? `, ${read.written.notRead} ${read.written.notRead === 1 ? 'entry' : 'entries'} not read` : ''}` : read.result === undefined ? 'found nothing' : coverageOf(read.result));
const readLine = (key: string, read: ReadDone): string => `${key}: read of ${read.label ?? read.tool}: ${findingOf(read)}`;

/**
 * The lines the model may cite. The elements the reads listed, once each (those of a view keep the view's keys, the reads' are r1, r2, ...): the type and the title as the result gave them (masked as it was asked), never
 * a property value. Then one line for each read, written by the server (s1, s2, ...): what the read found with its count and its quality, so that a sentence can state that a read found nothing and the numbers of the
 * sentence are checked against the line it cites. A read's key is no element: it is in the lines and the checked keys and never in the citations.
 */
export interface AssembledResults {
  readonly assembled: AssembledText;
  /** The keys of lines that state what a read found or are operator text, and are no element. */
  readonly readKeys: readonly string[];
  /** The lines of the AI notes, `a1`, `a2`, …: model-written text given to the model beside the elements and never a source of the checks, so they are not in `assembled`. */
  readonly noteLines: readonly string[];
  /** For each `a` key, the keys of the elements its sentence rests on: what the key stands for in the checks. */
  readonly noteElements: ReadonlyMap<string, readonly string[]>;
}

export function assembleResults(reads: readonly ReadDone[], view?: AssembledText): AssembledResults {
  const inexactCounts = [...(view?.inexactCounts ?? [])];
  const unknownCountKeys = new Set(view?.unknownCountKeys);
  const keys = new Map<string, ElementKey>(view?.keys);
  const lines = new Map<string, string>(view?.lines);
  const seen = new Map<string, string>();
  let number = 0;
  const keyFor = (id: string, element: ElementKey['ref'], type: string, title: string): string => {
    const held = seen.get(id);
    if (held !== undefined) return held;
    number += 1;
    const key = `r${number}`;
    seen.set(id, key);
    keys.set(key, 'entityType' in element ? { kind: 'entity', ref: element, title } : { kind: 'relationship', ref: element, title });
    lines.set(key, 'entityType' in element ? `${key}: ${type}: ${title}` : `${key}: ${title}`);
    return key;
  };
  for (const read of reads) {
    for (const [id, listed] of (read.result === undefined ? undefined : listedElements(read.result)) ?? []) {
      if (seen.has(id)) continue;
      seen.set(id, '');
      number += 1;
      const key = `r${number}`;
      seen.set(id, key);
      // the title the result gave, masked as it was asked, goes with the key: an element the person has not drawn is still named
      keys.set(key, 'entityType' in listed.element ? { kind: 'entity', ref: listed.element, title: listed.title } : { kind: 'relationship', ref: listed.element, title: listed.title });
      // a relationship's title already begins with its type
      lines.set(key, 'entityType' in listed.element ? `${key}: ${listed.type}: ${listed.title}` : `${key}: ${listed.title}`);
    }
  }
  // the lines of the typology: operator text, each with a key of its own that is no element
  let typologyNumber = 0;
  const typologyKeys: string[] = [];
  for (const read of reads) {
    for (const line of read.typology ?? []) {
      typologyNumber += 1;
      const key = `t${typologyNumber}`;
      typologyKeys.push(key);
      lines.set(key, `${key}: ${line}`);
    }
  }
  // the sentences of the person's AI notes: each with a key of its own and the elements it rests on, which keep the keys of the elements of the reads
  let noteNumber = 0;
  const noteLines: string[] = [];
  const noteElements = new Map<string, readonly string[]>();
  for (const read of reads) {
    for (const sentence of read.written?.sentences ?? []) {
      noteNumber += 1;
      const key = `a${noteNumber}`;
      const rests = [...new Set(sentence.citations.map((citation) => keyFor(refId(citation.ref as never), citation.ref as ElementKey['ref'], citation.type, citation.kind === 'relationship' ? `${citation.type}: ${citation.title}` : citation.title)))];
      noteElements.set(key, rests);
      noteLines.push(`${key}: ${sentence.text}${rests.length === 0 ? '' : ` (rests on ${rests.join(', ')})`}`);
    }
  }
  const readKeys = [...reads.map((_, index) => `s${index + 1}`), ...typologyKeys];
  reads.forEach((read, index) => {
    lines.set(`s${index + 1}`, readLine(`s${index + 1}`, read));
    const inexact = read.result === undefined ? undefined : inexactCountOf(read.result);
    if (inexact === 'unknown') unknownCountKeys.add(`s${index + 1}`);
    else if (inexact !== undefined) inexactCounts.push(inexact);
  });
  return { assembled: { text: [...lines.values()].join('\n'), keys, lines, inexactCounts, unknownCountKeys, carriesPropertyValues: view?.carriesPropertyValues ?? false }, readKeys, noteLines, noteElements };
}

const NOTES_HEADING = "Sentences written by a model: the AI notes the person copied into this investigation's draft, or an AI case summary drafted for this turn (each lists the elements it rests on; cite those elements, or its a key, and never copy a name, a figure or a claim from it that the elements do not state)";

const valuesOf = (message: string, assembled: AssembledText, coverage: string, context?: string, noteLines: readonly string[] = []): string => `Question:\n${message}\n\nWhat the reads returned (cite an s line to state what a read found, including that it found nothing; a t line is a line of the product's list of shapes of money movement, which may be cited to name a shape):\n${assembled.text}${noteLines.length === 0 ? '' : `\n\n${NOTES_HEADING}:\n${noteLines.join('\n')}`}\n\nCoverage:\n${coverage}${context === undefined ? '' : `\n\nEarlier turns of this conversation, given only so that the question can be placed (their keys, such as c1, are not elements in view and are never cited):\n${context}`}`;

/**
 * The model's answer after the tool steps: sentences that cite the elements the steps returned, put through the summary's checks (every sentence cites a key that was returned, a number occurs in the lines it cites,
 * a name that was not given is removed, verdict wording is rejected). A reply that fails may be asked for again within the calls limit and never beyond it; with no sentence left the answer is unsupported.
 */
export function createToolAnswer(options: ToolAnswerOptions): (input: ToolAnswerInput) => Promise<ToolAnswerOutcome> {
  const now = options.now ?? Date.now;
  return async (input) => {
    const instructions = options.instructions();
    if (instructions === undefined) return { kind: 'failed', why: 'service', calls: 0 };
    const { assembled, readKeys, noteLines, noteElements } = assembleResults(input.reads, input.view?.assembled);
    if (assembled.keys.size === 0 && readKeys.length === 0) return { kind: 'unsupported', calls: 0 };
    const coverage = [...(input.view === undefined ? [] : [`view: ${retrievalLine(input.view.reading)}`]), ...input.reads.map((read, index) => `read ${index + 1}, ${read.tool}: ${findingOf(read)}`)].join('; ');
    const typeLines = typeLinesOf(input.scope.request.typeDescriptions?.(input.scope.sourceId), assembled, input.message, input.scope.askedTypes, input.scope.contextTypes);
    const values = valuesOf(input.message, assembled, coverage, input.context, noteLines) + typeLines.section;
    const remaining = input.startedAt + options.totalTimeoutMs - now();
    if (remaining <= 0 || input.deadline.aborted) return { kind: 'limit', limit: 'time', calls: 0 };
    const allowed = input.maxCalls - input.callsUsed;
    if (allowed < 1) return { kind: 'limit', limit: 'calls', calls: 0 };
    if (estimateTokens(instructions.text, values) > input.maxInputTokens) return { kind: 'limit', limit: 'input', calls: 0 };
    const checkable = checkedTextOf(assembled);
    const checkedText = withTypeLines({ ...checkable, keys: new Map([...checkable.keys, ...readKeys.map((key) => [key, true] as const)]), readKeys: new Set(readKeys) }, typeLines);
    const turnSignal = AbortSignal.any([input.signal, input.deadline]);
    let calls = 0;
    let lastNames: readonly string[] | undefined;
    let drafted: DraftedOrAlternative;
    try {
      drafted = await draftSummary({
        call: options.model,
        context: { action: ANSWER_AUDIT_ACTION, actorId: input.scope.request.principalId, actorRole: input.scope.request.principalRole, traceId: input.scope.request.traceId, ...auditInvestigationOf(input.scope.investigationId ?? ''), sourceId: input.scope.sourceId },
        instructions: instructions.text,
        values,
        prompt: { id: ANSWER_PROMPT_ID, version: ANSWER_PROMPT_VERSION },
        maxInputTokens: input.maxInputTokens,
        alternative: (text: string) => noDescriptionReplyOf(text, typeLines) !== undefined,
        noDescription: (names: readonly string[]) => {
          const found = undescribedNamesOf(names, typeLines);
          lastNames = found;
          return found === undefined ? undefined : noDescriptionSentence(found);
        },
        judge: async (sentences, signal) => {
          const checked = await options.checks.run(judgeCheck, { sentences: withElementsOfNotes(sentences, noteElements), text: checkedText }, { timeoutMs: options.timeoutMs, signal });
          return checked.status === 'refused' ? { refused: checked.reason } : checked.value;
        },
        maxCalls: allowed,
        repeats: 1,
        totalTimeoutMs: remaining,
        signal: turnSignal,
        now,
        onCall: (made) => void (calls = made),
        trace: (call) => {
          const record = startModelCall({ modelRef: options.model.modelRef, promptId: ANSWER_PROMPT_ID, promptVersion: ANSWER_PROMPT_VERSION, instructionsSha256: instructions.sha256, instructions: call.instructions, values: call.values });
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
      if (input.signal.aborted) throw new Error('the request was cancelled');
      return input.deadline.aborted ? { kind: 'limit', limit: 'time', calls } : { kind: 'failed', why: 'service', calls };
    }
    switch (drafted.status) {
      case 'alternative': {
        const asked = noDescriptionReplyOf(drafted.text, typeLines);
        if (asked === undefined) return { kind: 'unsupported', calls: drafted.calls };
        const alone = undescribedOf(asked, typeLines);
        return { kind: 'noDescription', sentence: noDescriptionSentence(alone), names: alone, calls: drafted.calls };
      }
      case 'tooLarge':
        return { kind: 'limit', limit: 'input', calls: drafted.calls };
      case 'timeLimit':
        return { kind: 'limit', limit: 'time', calls: drafted.calls };
      case 'failed':
        return drafted.kind === 'format' ? { kind: 'unsupported', calls: drafted.calls } : { kind: 'failed', why: failureOf(drafted.kind), calls: drafted.calls };
      case 'drafted': {
        const fixed = undescribedOf(drafted.noDescription === undefined ? undefined : lastNames, typeLines);
        if (drafted.sentences.length === 0 || drafted.verdictFound) return fixed.length > 0 ? { kind: 'noDescription', sentence: noDescriptionSentence(fixed), names: fixed, calls: drafted.calls } : { kind: 'unsupported', calls: drafted.calls };
        const cited = new Set(drafted.sentences.flatMap((sentence) => sentence.cites));
        const citations = [...cited].flatMap((key) => {
          const element = assembled.keys.get(key);
          return element === undefined ? [] : [{ key, kind: element.kind, ref: element.ref, ...(citationTitleOf(element.title) === undefined ? {} : { title: citationTitleOf(element.title) }) }];
        });
        const withDescriptions = [...citations, ...descriptionCitationsOf(drafted.sentences, typeLines)];
        return { kind: 'sentences', sentences: drafted.sentences, citations: withDescriptions, coverage: { retrieval: coverage, summary: `The answer cites ${citations.length} of the ${assembled.keys.size} elements the reads returned.` }, model: options.model.modelRef, calls: drafted.calls, ...(fixed.length === 0 ? {} : { noDescription: noDescriptionSentence(fixed) }) };
      }
      default: {
        const unreachable: never = drafted;
        return unreachable;
      }
    }
  };
}
