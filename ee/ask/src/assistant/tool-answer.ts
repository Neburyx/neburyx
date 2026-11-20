import { ASSISTANT_CITATION_TITLE_MAX, type AskRunResult, type SummaryReading, type AssistantFailureKind, type AssistantTurnAnswer, type SummarySentence } from '@neburyx/contracts';
import { AuditUnavailableError, type AuditedModelCall, type CheckRunner } from '@neburyx/ee-ai-runtime';
import { type AssembledText, estimateTokens } from '../case-summary/assemble.js';
import { retrievalLine } from '../case-summary/coverage.js';
import { draftSummary, type Drafted } from '../case-summary/draft.js';
import { checkedTextOf, judgeCheck } from '../case-summary/judge.js';
import { auditInvestigationOf } from '../case-summary/summarizer.js';
import { listedElements } from '../summary/index.js';
import { coverageOf, inexactCountOf } from './coverage.js';
import { noteModelAnswer, startModelCall } from './turn-audit.js';
import type { StepScope } from './tool-step.js';
import type { ViewInstructions } from './view-instructions.js';

export const ANSWER_PROMPT_ID = 'assistant.answer';
export const ANSWER_PROMPT_VERSION = 1;
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
  readonly result?: AskRunResult;
}

export interface ToolAnswerInput {
  readonly scope: StepScope;
  readonly message: string;
  /** The reads of the turn in order: the tool and what it returned, or nothing for a read that found nothing. */
  readonly reads: readonly ReadDone[];
  /** What the view showed, when the loop was entered from the view: its elements keep the keys the view call gave them. */
  readonly view?: { readonly assembled: AssembledText; readonly reading: SummaryReading };
  readonly steps: number;
  readonly callsUsed: number;
  readonly maxCalls: number;
  readonly maxInputTokens: number;
  readonly startedAt: number;
  readonly signal: AbortSignal;
  readonly deadline: AbortSignal;
}

export type ToolAnswerOutcome =
  | { readonly kind: 'sentences'; readonly sentences: readonly SummarySentence[]; readonly citations: Extract<AssistantTurnAnswer, { status: 'answered'; sentences: unknown }>['citations']; readonly coverage: { readonly retrieval: string; readonly summary: string }; readonly model: string; readonly calls: number }
  | { readonly kind: 'unsupported'; readonly calls: number }
  | { readonly kind: 'limit'; readonly limit: 'calls' | 'time' | 'input'; readonly calls: number }
  | { readonly kind: 'failed'; readonly why: AssistantFailureKind; readonly calls: number };

type ElementKey = NonNullable<ReturnType<AssembledText['keys']['get']>>;

const failureOf = (kind: string): AssistantFailureKind => (kind === 'timeout' ? 'timeout' : kind === 'rate-limited' ? 'rate-limit' : 'service');

/** The title a citation carries: the element's own, cut to what the contract allows (its length in UTF-16 code units, as the schema counts it) without splitting a surrogate pair, and none when it is blank. */
export function citationTitleOf(title: string | undefined): string | undefined {
  if (title === undefined || title.trim() === '') return undefined;
  if (title.length <= ASSISTANT_CITATION_TITLE_MAX) return title;
  const cut = title.slice(0, ASSISTANT_CITATION_TITLE_MAX);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

const readLine = (key: string, read: ReadDone): string => `${key}: read of ${read.tool}: ${read.result === undefined ? 'found nothing' : coverageOf(read.result)}`;

/**
 * The lines the model may cite. The elements the reads listed, once each (those of a view keep the view's keys, the reads' are r1, r2, ...): the type and the title as the result gave them (masked as it was asked), never
 * a property value. Then one line for each read, written by the server (s1, s2, ...): what the read found with its count and its quality, so that a sentence can state that a read found nothing and the numbers of the
 * sentence are checked against the line it cites. A read's key is no element: it is in the lines and the checked keys and never in the citations.
 */
export function assembleResults(reads: readonly ReadDone[], view?: AssembledText): { readonly assembled: AssembledText; readonly readKeys: readonly string[] } {
  const inexactCounts = [...(view?.inexactCounts ?? [])];
  const unknownCountKeys = new Set(view?.unknownCountKeys);
  const keys = new Map<string, ElementKey>(view?.keys);
  const lines = new Map<string, string>(view?.lines);
  const seen = new Set<string>();
  let number = 0;
  for (const read of reads) {
    for (const [id, listed] of (read.result === undefined ? undefined : listedElements(read.result)) ?? []) {
      if (seen.has(id)) continue;
      seen.add(id);
      number += 1;
      const key = `r${number}`;
      // the title the result gave, masked as it was asked, goes with the key: an element the person has not drawn is still named
      keys.set(key, 'entityType' in listed.element ? { kind: 'entity', ref: listed.element, title: listed.title } : { kind: 'relationship', ref: listed.element, title: listed.title });
      lines.set(key, `${key}: ${listed.type}: ${listed.title}`);
    }
  }
  const readKeys = reads.map((_, index) => `s${index + 1}`);
  reads.forEach((read, index) => {
    lines.set(`s${index + 1}`, readLine(`s${index + 1}`, read));
    const inexact = read.result === undefined ? undefined : inexactCountOf(read.result);
    if (inexact === 'unknown') unknownCountKeys.add(`s${index + 1}`);
    else if (inexact !== undefined) inexactCounts.push(inexact);
  });
  return { assembled: { text: [...lines.values()].join('\n'), keys, lines, inexactCounts, unknownCountKeys, carriesPropertyValues: view?.carriesPropertyValues ?? false }, readKeys };
}

const valuesOf = (message: string, assembled: AssembledText, coverage: string): string => `Question:\n${message}\n\nWhat the reads returned (cite an s line to state what a read found, including that it found nothing):\n${assembled.text}\n\nCoverage:\n${coverage}`;

/**
 * The model's answer after the tool steps: sentences that cite the elements the steps returned, put through the summary's checks (every sentence cites a key that was returned, a number occurs in the lines it cites,
 * a name that was not given is removed, verdict wording is rejected). A reply that fails may be asked for again within the calls limit and never beyond it; with no sentence left the answer is unsupported.
 */
export function createToolAnswer(options: ToolAnswerOptions): (input: ToolAnswerInput) => Promise<ToolAnswerOutcome> {
  const now = options.now ?? Date.now;
  return async (input) => {
    const instructions = options.instructions();
    if (instructions === undefined) return { kind: 'failed', why: 'service', calls: 0 };
    const { assembled, readKeys } = assembleResults(input.reads, input.view?.assembled);
    if (assembled.keys.size === 0 && readKeys.length === 0) return { kind: 'unsupported', calls: 0 };
    const coverage = [...(input.view === undefined ? [] : [`view: ${retrievalLine(input.view.reading)}`]), ...input.reads.map((read, index) => `read ${index + 1}, ${read.tool}: ${read.result === undefined ? 'found nothing' : coverageOf(read.result)}`)].join('; ');
    const values = valuesOf(input.message, assembled, coverage);
    const remaining = input.startedAt + options.totalTimeoutMs - now();
    if (remaining <= 0 || input.deadline.aborted) return { kind: 'limit', limit: 'time', calls: 0 };
    const allowed = input.maxCalls - input.callsUsed;
    if (allowed < 1) return { kind: 'limit', limit: 'calls', calls: 0 };
    if (estimateTokens(instructions.text, values) > input.maxInputTokens) return { kind: 'limit', limit: 'input', calls: 0 };
    const checkable = checkedTextOf(assembled);
    const checkedText = { ...checkable, keys: new Map([...checkable.keys, ...readKeys.map((key) => [key, true] as const)]), readKeys: new Set(readKeys) };
    const turnSignal = AbortSignal.any([input.signal, input.deadline]);
    let calls = 0;
    let drafted: Drafted;
    try {
      drafted = await draftSummary({
        call: options.model,
        context: { action: ANSWER_AUDIT_ACTION, actorId: input.scope.request.principalId, actorRole: input.scope.request.principalRole, traceId: input.scope.request.traceId, ...auditInvestigationOf(input.scope.investigationId ?? ''), sourceId: input.scope.sourceId },
        instructions: instructions.text,
        values,
        prompt: { id: ANSWER_PROMPT_ID, version: ANSWER_PROMPT_VERSION },
        maxInputTokens: input.maxInputTokens,
        judge: async (sentences, signal) => {
          const checked = await options.checks.run(judgeCheck, { sentences, text: checkedText }, { timeoutMs: options.timeoutMs, signal });
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
      case 'tooLarge':
        return { kind: 'limit', limit: 'input', calls: drafted.calls };
      case 'timeLimit':
        return { kind: 'limit', limit: 'time', calls: drafted.calls };
      case 'failed':
        return drafted.kind === 'format' ? { kind: 'unsupported', calls: drafted.calls } : { kind: 'failed', why: failureOf(drafted.kind), calls: drafted.calls };
      case 'drafted': {
        if (drafted.sentences.length === 0 || drafted.verdictFound) return { kind: 'unsupported', calls: drafted.calls };
        const cited = new Set(drafted.sentences.flatMap((sentence) => sentence.cites));
        const citations = [...cited].flatMap((key) => {
          const element = assembled.keys.get(key);
          return element === undefined ? [] : [{ key, kind: element.kind, ref: element.ref, ...(citationTitleOf(element.title) === undefined ? {} : { title: citationTitleOf(element.title) }) }];
        });
        return { kind: 'sentences', sentences: drafted.sentences, citations, coverage: { retrieval: coverage, summary: `The answer cites ${citations.length} of the ${assembled.keys.size} elements the reads returned.` }, model: options.model.modelRef, calls: drafted.calls };
      }
      default: {
        const unreachable: never = drafted;
        return unreachable;
      }
    }
  };
}
