import { readViewKeys, type AssistantFailureKind, type AssistantTurnAnswer, type ExtensionRequest, type SummaryReading } from '@neburyx/contracts';
import { AuditUnavailableError, type AuditedModelCall, type CheckRunner, type FailureCode, type GateClient } from '@neburyx/ee-ai-runtime';
import { prepareSummary } from '../case-summary/prepare.js';
import { citationsOf, retrievalLine, summaryLine } from '../case-summary/coverage.js';
import { draftSummary, type Drafted } from '../case-summary/draft.js';
import { checkedTextOf, judgeCheck } from '../case-summary/judge.js';
import { auditInvestigationOf } from '../case-summary/summarizer.js';
import { noteModelAnswer, startModelCall } from './turn-audit.js';
import type { ViewInstructions } from './view-instructions.js';

export const VIEW_PROMPT_ID = 'assistant.view';
export const VIEW_PROMPT_VERSION = 1;
const VIEW_AUDIT_ACTION = 'assistant.view';

interface ViewAnswerSettings {
  readonly model: string;
  readonly maxInputTokens: number;
  readonly maxCalls: number;
  readonly totalTimeoutMs: number;
  readonly timeoutMs: number;
}

export interface ViewAnswerOptions {
  readonly model: AuditedModelCall;
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
}

type StoppedBecause = 'deadline' | 'input' | 'calls';

/** What the answer came to, with what was reached: the answer calls made, the elements read, the model of the accepted reply and how many elements the sentences cite. */
type ViewResult =
  | { readonly status: 'answered'; readonly answer: Extract<AssistantTurnAnswer, { status: 'answered'; route: 'view' }>; readonly cited: number }
  | { readonly status: 'unsupported' }
  | { readonly status: 'invalid-keys' }
  | { readonly status: 'failed'; readonly kind: AssistantFailureKind }
  | { readonly status: 'stopped'; readonly because: StoppedBecause }
  | { readonly status: 'cancelled' };

export type ViewOutcome = ViewResult & { readonly calls: number; readonly read: number; readonly readStarted: boolean };

const kindOf = (code: FailureCode): AssistantFailureKind => (code === 'timeout' ? 'timeout' : code === 'rate-limited' ? 'rate-limit' : 'service');

const valuesOf = (message: string, text: string): string => `Question:\n${message}\n\nElements in view:\n${text}`;

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
    const outcome = (rest: ViewResult): ViewOutcome => ({ ...rest, calls: progress.calls, read: progress.read, readStarted: progress.readStarted });
    const instructions = options.instructions();
    const settings = options.settings();
    if (instructions === undefined || settings === undefined) return outcome({ status: 'failed', kind: 'service' });
    const keys = readViewKeys(input.viewElementKeys, input.sourceId);
    if (!keys.ok) return outcome({ status: 'invalid-keys' });
    const { entities, edges, aggregates, derived } = keys.refs;
    if (entities.length + edges.length + aggregates.length + derived.length === 0) return outcome({ status: 'unsupported' });
    const remaining = input.startedAt + settings.totalTimeoutMs - now();
    if (remaining <= 0 || input.deadline.aborted) return outcome({ status: 'stopped', because: 'deadline' });
    if (input.signal.aborted) return outcome({ status: 'cancelled' });
    const turnSignal = AbortSignal.any([input.signal, input.deadline]);
    const ended = (): ViewOutcome | undefined => (input.signal.aborted ? outcome({ status: 'cancelled' }) : input.deadline.aborted ? outcome({ status: 'stopped', because: 'deadline' }) : undefined);
    let reading: SummaryReading;
    progress.readStarted = true;
    try {
      reading = await until(input.readElements({ investigationId: input.investigationId, sourceId: input.sourceId, mask: input.mask, signal: turnSignal }, keys.refs), turnSignal);
    } catch (error) {
      const stopped = ended();
      if (stopped === undefined) throw error;
      return stopped;
    }
    progress.read = reading.nodes.length + reading.edges.length;
    if (progress.read === 0) return outcome({ status: 'unsupported' });
    const prepared = prepareSummary(reading, instructions.text, settings.maxInputTokens);
    if (!prepared.ready) return outcome({ status: 'stopped', because: 'input' });
    const { assembled } = prepared;
    const allowed = settings.maxCalls - input.callsUsed;
    if (allowed < 1) return outcome({ status: 'stopped', because: 'calls' });
    const checkedText = checkedTextOf(assembled);
    let drafted: Drafted;
    try {
      drafted = await draftSummary({
        call: options.model,
        context: { action: VIEW_AUDIT_ACTION, actorId: input.actorId, actorRole: input.actorRole, traceId: input.traceId, ...auditInvestigationOf(input.investigationId), sourceId: input.sourceId },
        instructions: instructions.text,
        values: valuesOf(input.message, assembled.text),
        prompt: { id: VIEW_PROMPT_ID, version: VIEW_PROMPT_VERSION },
        maxInputTokens: settings.maxInputTokens,
        judge: async (sentences, signal) => {
          const checked = await options.checks.run(judgeCheck, { sentences, text: checkedText }, { timeoutMs: settings.timeoutMs, signal });
          return checked.status === 'refused' ? { refused: checked.reason } : checked.value;
        },
        maxCalls: allowed,
        repeats: 1,
        totalTimeoutMs: remaining,
        signal: turnSignal,
        now,
        onCall: (calls) => void (progress.calls = calls),
        trace: (call) => {
          const record = startModelCall({ modelRef: options.model.modelRef, promptId: VIEW_PROMPT_ID, promptVersion: VIEW_PROMPT_VERSION, instructionsSha256: instructions.sha256, instructions: call.instructions, values: call.values });
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
      case 'tooLarge':
        return outcome({ status: 'stopped', because: 'input' });
      case 'timeLimit':
        return outcome({ status: 'stopped', because: 'deadline' });
      case 'failed':
        // a reply that never fit the format, after the one repeat, is the fixed not-answered turn
        return drafted.kind === 'format' ? outcome({ status: 'unsupported' }) : outcome({ status: 'failed', kind: kindOf(drafted.kind === 'rate-limited' ? 'rate-limited' : drafted.kind === 'timeout' ? 'timeout' : 'provider-error') });
      case 'drafted': {
        if (drafted.sentences.length === 0 || drafted.verdictFound) return outcome({ status: 'unsupported' });
        const citations = [...citationsOf(drafted.sentences, assembled)];
        const answer = { status: 'answered' as const, route: 'view' as const, sentences: [...drafted.sentences], citations, coverage: { retrieval: retrievalLine(reading), summary: summaryLine(drafted.sentences, reading) }, model: drafted.model, calls: progress.calls + input.callsUsed };
        return outcome({ status: 'answered', answer, cited: citations.length });
      }
      default: {
        const unreachable: never = drafted;
        return unreachable;
      }
    }
  };
}
