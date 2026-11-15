import { createHash } from 'node:crypto';
import type { AuditResult, AuditSink, CaseSummarizer, CaseSummaryAuditDetail, CaseSummaryInput, CaseSummaryOutcome } from '@neburyx/contracts';
import { AuditUnavailableError, type AuditedModelCall } from '../audited.js';
import { canonicalText } from '../questions/canonical.js';
import { draftSummary } from './draft.js';
import type { SummaryInstructions } from './instructions.js';
import { prepareSummary } from './prepare.js';
import type { SummaryAvailability, SummarySettings } from './settings.js';
import { sealToken } from './token.js';
import type { TokenKeys } from './token-keys.js';

const SUMMARY_AUDIT_ACTION = 'ai.case-summary';

/** The action of the closing event of a click: the one event that says how it ended, beside the event of each model call. */
export const SUMMARY_CLOSING_ACTION = 'ai.case-summary.closed';

const PROMPT_ID = 'case-summary';
const PROMPT_VERSION = '1';

interface SummarizerOptions {
  readonly settings: SummarySettings;
  readonly instructions: SummaryInstructions;
  readonly model: () => AuditedModelCall | undefined;
  readonly audit: () => AuditSink | undefined;
  readonly tokenKeys: () => TokenKeys | undefined;
  readonly availability: () => SummaryAvailability;
  readonly now?: () => number;
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

const resultOf = (outcome: CaseSummaryOutcome): AuditResult => (outcome.status === 'ok' ? 'success' : outcome.status === 'tooLarge' ? 'refused' : 'failed');

/** Drafts the summary of a read view: measures the text against the size guard, then calls the model within the operator's limits. */
export function createCaseSummarizer(options: SummarizerOptions): CaseSummarizer {
  const { settings, instructions } = options;
  return {
    maxElements: settings.maxElements,
    availability: options.availability,
    async summarize(input: CaseSummaryInput, signal: AbortSignal): Promise<CaseSummaryOutcome> {
      const call = options.model();
      const guard = settings.maxInputTokens;
      if (call === undefined || guard === undefined || options.tokenKeys() === undefined) throw new Error('the case summarizer was asked while it is not available');
      const prepared = prepareSummary(input.reading, instructions.text, guard);
      const write = async (calls: number, outcome: CaseSummaryAuditDetail['outcome'], result: AuditResult): Promise<void> => {
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
          outcome,
        };
        try {
          await sink.record({ actorId: input.actorId, actorRole: input.actorRole, action: SUMMARY_CLOSING_ACTION, result, sourceId: input.request.sourceId, ...auditInvestigationOf(input.request.investigationId), traceId: input.traceId, detail: { summary: detail } });
        } catch {
          throw new AuditUnavailableError();
        }
      };
      const record = async (outcome: CaseSummaryOutcome): Promise<CaseSummaryOutcome> => {
        await write(outcome.status === 'tooLarge' ? 0 : outcome.calls, outcome.status === 'failed' ? outcome.kind : outcome.status, resultOf(outcome));
        return outcome;
      };
      if (!prepared.ready) return record(prepared.refusal);
      let callsMade = 0;
      try {
        const drafted = await draftSummary({
          call,
          context: { action: SUMMARY_AUDIT_ACTION, actorId: input.actorId, actorRole: input.actorRole, traceId: input.traceId, ...auditInvestigationOf(input.request.investigationId), sourceId: input.request.sourceId },
          instructions: instructions.text,
          values: prepared.assembled.text,
          maxCalls: settings.maxCalls,
          totalTimeoutMs: settings.totalTimeoutMs,
          signal,
          onCall: (calls) => void (callsMade = calls),
          ...(options.now === undefined ? {} : { now: options.now }),
        });
        if (drafted.status === 'timeLimit') return record({ status: 'timeLimit', calls: drafted.calls });
        if (drafted.status === 'failed') return record({ status: 'failed', kind: drafted.kind, calls: drafted.calls });
        const keys = options.tokenKeys();
        if (keys === undefined) throw new Error('the case summarizer was asked without a sealing key');
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
          },
          (options.now ?? Date.now)(),
        );
        return record({ status: 'ok', sentences: [...drafted.sentences], sent: prepared.assembled.text, model: settings.model, calls: drafted.calls, summaryToken });
      } catch (error) {
        if (error instanceof AuditUnavailableError) throw error;
        await write(callsMade, signal.aborted ? 'cancelled' : 'error', 'failed').catch(() => undefined);
        throw new SummaryHandled(error);
      }
    },
  };
}
