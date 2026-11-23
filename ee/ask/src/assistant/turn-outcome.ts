import { ASK_TEMPLATE_IDS, valueNotFitSentence, type AskAnswer, type AssistantRead, type AssistantFailureKind, type AssistantLimit } from '@neburyx/contracts';
import { buildToolRegistry } from './tool-registry.js';
import type { ToolAnswerOutcome } from './tool-answer.js';
import type { PlanStep } from './plan-token.js';
import type { ToolRequest } from './tool-request.js';
import type { StepScope } from './tool-step.js';

const TEMPLATES: readonly string[] = ASK_TEMPLATE_IDS;

const typologyOf = (scope: Pick<StepScope, 'options' | 'sourceId'>): readonly string[] | undefined => scope.options.typology?.(scope.sourceId);

/** The tools a turn may ask for in this scope: the source's intents, the catalog templates, the person's patterns and, when it can be read again, the view. */
export const toolRegistryOf = (scope: Pick<StepScope, 'options' | 'sourceId' | 'patterns' | 'request' | 'viewElementKeys'>, viewReadable: boolean) =>
  buildToolRegistry({ source: scope.options.folder()?.source(scope.sourceId), patterns: scope.patterns?.built, viewReadable, templateRunnable: (template) => TEMPLATES.includes(template), notes: scope.request.aiNotes !== undefined, summary: scope.viewElementKeys.length > 0 && scope.request.caseSummarizer.availability().available, ...(typologyOf(scope) === undefined ? {} : { typology: typologyOf(scope) }) });

type Answered = Extract<AskAnswer, { answered: unknown }>['answered'];
type Refused = Extract<AskAnswer, { refused: unknown }>['refused'];

/** The refusal of a step that came after reads that did run: the same fixed sentence, saying that this step was not run and that the results above stand, not that nothing was run. */
export const afterReads = (refused: Refused): Refused => (refused.valueNotFit === undefined ? refused : { ...refused, sentence: valueNotFitSentence({ kind: refused.valueNotFit.kind, needed: refused.valueNotFit.needed, found: refused.valueNotFit.found, title: refused.valueNotFit.citation?.title, laterStep: true }) });

export interface ResumeState {
  readonly steps: readonly PlanStep[];
  readonly wait: PlanStep;
  readonly fromView: boolean;
  readonly decision: 'confirm' | 'skip';
  /** The steps, rows and model calls the turn had before the wait. */
  readonly counters: { readonly steps: number; readonly rows: number; readonly calls: number };
}

/** What a turn on the agent comes to. */
export type LoopOutcome =
  /** The model needs nothing more, or the loop could not go on without losing what it had: `answer` is the answer of the last step that read something, and `steps` how many ran. */
  | { readonly kind: 'finished'; readonly answer: Answered; readonly steps: number; readonly reads: readonly AssistantRead[]; readonly stoppedAt?: AssistantLimit }
  /** A heavy step the analyst has to confirm: nothing of it was read. The steps before it and the counters are what a decision needs to go on. */
  | { readonly kind: 'waiting'; readonly wait: { readonly request: ToolRequest; readonly answer: Answered }; readonly steps: readonly PlanStep[]; readonly counters: { readonly steps: number; readonly rows: number; readonly calls: number }; readonly reads: readonly AssistantRead[]; readonly fromView: boolean }
  /** The checked answer after tool steps: sentences that cite the elements the steps returned. */
  | { readonly kind: 'table'; readonly answer: Extract<ToolAnswerOutcome, { kind: 'table' }>; readonly steps: number; readonly calls: number; readonly reads: readonly AssistantRead[]; readonly stoppedAt?: AssistantLimit }
  | { readonly kind: 'sentences'; readonly answer: Extract<ToolAnswerOutcome, { kind: 'sentences' }>; readonly steps: number; readonly calls: number; readonly reads: readonly AssistantRead[]; readonly stoppedAt?: AssistantLimit; /** The answer of the last read of one of the folder's questions, which the follow-ups of an Ask answer are built from. */ readonly askAnswer?: Answered }
  | { readonly kind: 'no-description'; readonly sentence: string; readonly names: readonly string[]; readonly calls: number }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'failed'; readonly why: AssistantFailureKind }
  /** A step whose value the model wrote is not an element of the type its role needs: the turn ends here with the fixed refusal, and the reads the earlier steps made are the ones it lists. The model is not asked again. */
  | { readonly kind: 'misfit'; readonly refused: Refused; readonly reads: readonly AssistantRead[] }
  | { readonly kind: 'limit'; readonly limit: AssistantLimit; readonly reads: readonly AssistantRead[] }
  /** A tool request that is malformed after its repeat, or names a tool that is no longer available. */
  | { readonly kind: 'ended'; readonly because: 'malformed' | 'unavailable' };
