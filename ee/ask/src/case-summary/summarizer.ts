import { createHash } from 'node:crypto';
import type { AuditResult, AuditSink, CaseSummarizer, CaseSummaryAuditDetail, CaseSummaryInput, CaseSummaryOutcome, SummarySentence } from '@neburyx/contracts';
import { AuditUnavailableError, type AuditedModelCall } from '../audited.js';
import { canonicalText } from '../questions/canonical.js';
import { citationsOf, retrievalLine, summaryLine } from './coverage.js';
import { judgeSentences } from './checks.js';
import { draftSummary, type Checked } from './draft.js';
import type { SummaryInstructions } from './instructions.js';
import { storableMarkOf, templatesOf } from './notes-convert.js';
import { NOTES_WORD_LIST_VERSION } from './notes-words.js';
import { prepareSummary } from './prepare.js';
import { SummaryRunStoreError, type SummaryRunStore } from './run-store.js';
import type { SummaryAvailability, SummarySettings } from './settings.js';
import { sealToken } from './token.js';
import type { TokenKeys } from './token-keys.js';

const SUMMARY_AUDIT_ACTION = 'ai.case-summary';

/** The action of the closing event of a click: the one event that says how it ended, beside the event of each model call. */
export const SUMMARY_CLOSING_ACTION = 'ai.case-summary.closed';

const PROMPT_ID = 'case-summary';
const PROMPT_VERSION = '1';

/** What the checks did to one reply: the sentences the model wrote, the ones kept, and the counts. Handed to an observer as copies. */
export interface ReplyObservation {
  readonly written: readonly SummarySentence[];
  readonly kept: readonly SummarySentence[];
  readonly removed: number;
  readonly keysStripped: number;
  readonly keysRemoved: number;
  readonly verdictFound: boolean;
}

interface SummarizerOptions {
  readonly settings: SummarySettings;
  readonly instructions: SummaryInstructions;
  readonly model: () => AuditedModelCall | undefined;
  readonly audit: () => AuditSink | undefined;
  readonly tokenKeys: () => TokenKeys | undefined;
  /** The store of the record of each click; absent, no click can be made, since nothing sent to the model may go unrecorded. */
  readonly runs: () => SummaryRunStore | undefined;
  readonly availability: () => SummaryAvailability;
  readonly now?: () => number;
  /** Only the evaluation command passes this: it is told, for each reply the checks judge, what they did. It gets copies, and what it does or throws never changes the click. */
  readonly observe?: (observation: ReplyObservation) => void;
}

/** The investigation id as an audit event takes it: only a UUID, since the audit column is one; any other text is left out of the event, never refused. */
export const auditInvestigationOf = (investigationId: string): { readonly investigationId?: string } => (UUID_TEXT.test(investigationId) ? { investigationId } : {});

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Thrown by the summarizer for a failure after which its closing event was already written: the cause is the original failure, which the route passes on without a second event. */
export class SummaryHandled extends Error {
  constructor(readonly handled: unknown) {
    super('the case summary ended in a failure that was recorded');
    this.name = 'SummaryHandled';
  }
}

export const elementsHashOf = (refs: { readonly entities: readonly unknown[]; readonly edges: readonly unknown[]; readonly aggregates: readonly unknown[]; readonly derived: readonly unknown[] }): string =>
  createHash('sha256').update(canonicalText([refs.entities, refs.edges, refs.aggregates, refs.derived])).digest('hex');

export const elementCountOf = (refs: { readonly entities: readonly unknown[]; readonly edges: readonly unknown[]; readonly aggregates: readonly unknown[]; readonly derived: readonly unknown[] }): number =>
  refs.entities.length + refs.edges.length + refs.aggregates.length + refs.derived.length;

const resultOf = (outcome: CaseSummaryOutcome): AuditResult => (outcome.status === 'ok' ? 'success' : outcome.status === 'partial' ? 'partial' : outcome.status === 'tooLarge' ? 'refused' : 'failed');

/** Drafts the summary of a read view: measures the text against the size guard, then calls the model within the operator's limits. */
export function createCaseSummarizer(options: SummarizerOptions): CaseSummarizer {
  const { settings, instructions } = options;
  const observeReply = (written: readonly SummarySentence[], judged: ReturnType<typeof judgeSentences>): void => {
    if (options.observe === undefined) return;
    try {
      // a promise the observer returns is let go too: a rejection of it is not an unhandled one
      void Promise.resolve(options.observe(structuredClone({ written, kept: judged.kept, removed: judged.removed, keysStripped: judged.keysStripped, keysRemoved: judged.keysRemoved, verdictFound: judged.verdictFound }))).catch(() => undefined);
    } catch {
      // an observer that fails changes nothing of the click
    }
  };
  type Who = { readonly actorId: string; readonly actorRole: CaseSummaryInput['actorRole']; readonly traceId: string; readonly request: CaseSummaryInput['request'] };
  /** Writes the run row of a click and answers what ends it: the run row first, then the closing event; every failure of either is `AuditUnavailableError`. */
  async function openRun(input: Who) {
    const runs = options.runs();
    if (runs === undefined) throw new AuditUnavailableError();
    const stored = async <T>(work: () => Promise<T>): Promise<T> => {
      try {
        return await work();
      } catch (error) {
        if (error instanceof SummaryRunStoreError) throw new AuditUnavailableError();
        throw error;
      }
    };
    const runId = await stored(() =>
      runs.begin({
        actorId: input.actorId,
        ...auditInvestigationOf(input.request.investigationId),
        sourceId: input.request.sourceId,
        traceId: input.traceId,
        startedAt: new Date((options.now ?? Date.now)()),
        settings: { model: settings.model, timeoutMs: settings.timeoutMs, totalTimeoutMs: settings.totalTimeoutMs, maxCalls: settings.maxCalls, maxElements: settings.maxElements, maxOutputTokens: settings.maxOutputTokens, maxInputTokens: settings.maxInputTokens },
      }),
    );
    const publish = async (calls: number, outcome: CaseSummaryAuditDetail['outcome'], result: AuditResult, checked?: Checked): Promise<void> => {
      const sink = options.audit();
      if (sink === undefined) throw new AuditUnavailableError();
      const detail: CaseSummaryAuditDetail = {
        elements: elementCountOf(input.request),
        elementsSha256: elementsHashOf(input.request),
        calls,
        modelRef: settings.model,
        promptId: PROMPT_ID,
        promptVersion: PROMPT_VERSION,
        instructionsSha256: instructions.sha256,
        runId,
        outcome,
        ...(checked === undefined ? {} : { sentencesKept: checked.kept, sentencesRemoved: checked.removed }),
      };
      try {
        await sink.record({ actorId: input.actorId, actorRole: input.actorRole, action: SUMMARY_CLOSING_ACTION, result, sourceId: input.request.sourceId, ...auditInvestigationOf(input.request.investigationId), traceId: input.traceId, detail: { summary: detail } });
      } catch {
        throw new AuditUnavailableError();
      }
    };
    /** The run row ends with the outcome before the closing event says it; if the event then cannot be written the row says so, and the click fails closed. */
    const finalize = (calls: number, outcome: string): Promise<void> => stored(() => runs.finish(runId, outcome, calls, new Date((options.now ?? Date.now)())));
    /** `cancelled` says whether the client has given up: a click it gave up ends `cancelled`, before or after its row is written, whatever the draft was. */
    const write = async (calls: number, outcome: CaseSummaryAuditDetail['outcome'], result: AuditResult, checked?: Checked, cancelled?: () => boolean): Promise<void> => {
      const cancel = async (): Promise<never> => {
        await finalize(calls, 'cancelled');
        await publish(calls, 'cancelled', 'failed', checked).catch(() => undefined);
        throw new SummaryHandled(new Error('the request was cancelled'));
      };
      if (cancelled?.() === true) return cancel();
      await finalize(calls, outcome);
      if (cancelled?.() === true) return cancel();
      try {
        await publish(calls, outcome, result, checked);
      } catch (error) {
        await finalize(calls, 'auditFailed').catch(() => undefined);
        throw error;
      }
    };
    return { runId, runs, stored, finalize, publish, write };
  }

  return {
    maxElements: settings.maxElements,
    availability: options.availability,
    async recordEarlyEnd(end) {
      const { write } = await openRun(end);
      await write(0, end.outcome, end.outcome === 'tooLarge' ? 'refused' : 'failed');
    },
    async summarize(input: CaseSummaryInput, signal: AbortSignal): Promise<CaseSummaryOutcome> {
      const call = options.model();
      if (call === undefined || options.tokenKeys() === undefined) throw new Error('the case summarizer was asked while it is not available');
      const run = await openRun(input);
      const { runId, runs, stored, finalize, publish, write } = run;
      const prepared = prepareSummary(input.reading, instructions.text, settings.maxInputTokens);
      const record = async (outcome: CaseSummaryOutcome, checked?: Checked): Promise<CaseSummaryOutcome> => {
        await write(outcome.status === 'tooLarge' ? 0 : outcome.calls, outcome.status === 'failed' ? outcome.kind : outcome.status, resultOf(outcome), checked, () => signal.aborted);
        return outcome;
      };
      if (!prepared.ready) return record(prepared.refusal);
      let callsMade = 0;
      let lastChecked: Checked | undefined;
      try {
        const drafted = await draftSummary({
          call,
          context: { runId, action: SUMMARY_AUDIT_ACTION, actorId: input.actorId, actorRole: input.actorRole, traceId: input.traceId, ...auditInvestigationOf(input.request.investigationId), sourceId: input.request.sourceId },
          instructions: instructions.text,
          values: prepared.assembled.text,
          record: {
            beforeCall: (call) => stored(() => runs.beginCall({ runId, number: call.number, startedAt: call.startedAt, instructionsSha256: instructions.sha256, instructionsText: call.instructions, valuesText: call.values })),
            afterCall: (end) => stored(() => runs.endCall({ runId, ...end })),
          },
        judge: (sentences) => {
            const judged = judgeSentences(sentences, prepared.assembled);
            lastChecked = { kept: judged.kept.length, removed: judged.removed };
            observeReply(sentences, judged);
            return judged;
          },
          maxCalls: settings.maxCalls,
          totalTimeoutMs: settings.totalTimeoutMs,
          signal,
          onCall: (calls) => void (callsMade = calls),
          ...(options.now === undefined ? {} : { now: options.now }),
        });
        if (drafted.status === 'timeLimit') return record({ status: 'timeLimit', calls: drafted.calls }, drafted.checked);
        if (drafted.status === 'failed') return record({ status: 'failed', kind: drafted.kind, calls: drafted.calls }, drafted.checked);
        const coverage = { retrieval: retrievalLine(input.reading), summary: summaryLine(drafted.sentences, input.reading) };
        const checked = { kept: drafted.sentences.length, removed: drafted.removed };
        if (drafted.sentences.length === 0) return record({ status: 'unsupported', removedCount: drafted.removed, coverage, sent: prepared.assembled.text, model: settings.model, calls: drafted.calls }, checked);
        const keys = options.tokenKeys();
        if (keys === undefined) throw new Error('the case summarizer was asked without a sealing key');
        const templates = templatesOf(drafted.sentences, prepared.assembled, input.reading);
        const summaryToken = sealToken(
          keys,
          {
            investigationId: input.request.investigationId,
            generatedBy: input.actorId,
            policyVersion: input.policyVersion,
            modelRef: settings.model,
            promptId: PROMPT_ID,
            promptVersion: PROMPT_VERSION,
            sentences: drafted.sentences,
            inputRefs: [...prepared.assembled.keys].map(([key, element]) => ({ key, kind: element.kind, ref: element.ref })),
            propertyValuesSent: prepared.assembled.carriesPropertyValues,
            runId,
            mask: input.request.mask === true,
            wordListVersion: NOTES_WORD_LIST_VERSION,
            templates,
          },
          (options.now ?? Date.now)(),
        );
        return record({ status: drafted.removed === 0 ? 'ok' : 'partial', sentences: drafted.sentences.map((sentence, index) => storableMarkOf(sentence, templates[index])), citations: citationsOf(drafted.sentences, prepared.assembled), coverage, removedCount: drafted.removed, sent: prepared.assembled.text, model: settings.model, calls: drafted.calls, summaryToken }, checked);
      } catch (error) {
        if (error instanceof AuditUnavailableError) {
          // the click ends as unavailable: the run row says how far it got, if it can
          await finalize(callsMade, 'auditFailed').catch(() => undefined);
          throw error;
        }
        const ended = signal.aborted ? 'cancelled' : 'error';
        // the record of the run must end, whatever the audit does; a failure of the event alone leaves the failure the click had
        await finalize(callsMade, ended);
        await publish(callsMade, ended, 'failed', lastChecked).catch(() => undefined);
        throw new SummaryHandled(error);
      }
    },
  };
}
