import { ExtensionRefusal, summaryRequestSchema, summaryResponseSchema, type CaseSummaryAuditDetail, type ExtensionRequest, type ExtensionRoute, type SummaryRequest, type SummaryResponse } from '@neburyx/contracts';
import { AuditUnavailableError, gateClientOf } from '@neburyx/ee-ai-runtime';
import { SUMMARY_CLOSING_ACTION, SummaryHandled, auditInvestigationOf, elementCountOf, elementsHashOf } from './summarizer.js';

const SUMMARY_URL = '/v1/summary';

type EarlyOutcome = 'tooLarge' | 'read-failed' | 'cancelled' | 'error' | 'unavailable';

/** Records the closing event of a click that ended in the route, before or around the summarizer. The event is queued: a refusal or a failure the route is passing on keeps its own answer, whatever becomes of the event. */
async function closeEarly(request: ExtensionRequest, role: 'administrator' | 'investigator', body: SummaryRequest, outcome: EarlyOutcome): Promise<void> {
  const summarizer = request.caseSummarizer;
  if (summarizer.recordEarlyEnd !== undefined) {
    try {
      await summarizer.recordEarlyEnd({ actorId: request.principalId, actorRole: role, traceId: request.traceId, request: body, outcome });
    } catch (error) {
      // only a summarizer with no store or no sink to record to says so: a record that cannot be written is queued, counted and logged, and never reaches here
      if (error instanceof AuditUnavailableError) throw new ExtensionRefusal({ code: 'AUDIT_UNAVAILABLE' });
      throw error;
    }
    return;
  }
  const detail: CaseSummaryAuditDetail = { elements: elementCountOf(body), elementsSha256: elementsHashOf(body), calls: 0, outcome };
  // the application queues the event and counts and logs its own failures
  await request.audit
    .record({ actorId: request.principalId, actorRole: role, action: SUMMARY_CLOSING_ACTION, result: outcome === 'tooLarge' ? 'refused' : 'failed', sourceId: body.sourceId, ...auditInvestigationOf(body.investigationId), traceId: request.traceId, detail: { summary: detail } })
    .catch(() => undefined);
}

/** Drafts the summary of the view the request names, through the application's `CaseSummarizer`; the Community default and a summarizer that is not available both answer that the feature is not in this edition. */
export function createSummaryRoute(): ExtensionRoute {
  return {
    method: 'POST',
    url: SUMMARY_URL,
    permission: 'principal',
    requestSchema: summaryRequestSchema,
    responseSchema: summaryResponseSchema,
    idempotent: {
      sourceOf: (body) => summaryRequestSchema.parse(body).sourceId,
      recheck: async (request) => {
        if (request.principalRole !== 'administrator' && request.principalRole !== 'investigator') return false;
        const { investigationReadable } = gateClientOf(request);
        if (!request.caseSummarizer.availability().available || investigationReadable === undefined) return false;
        const body = summaryRequestSchema.parse(request.body);
        try {
          await investigationReadable(body.investigationId, body.sourceId);
          return true;
        } catch {
          return false;
        }
      },
      retryable: (answer) => summaryResponseSchema.safeParse(answer).data?.status === 'failed' || summaryResponseSchema.safeParse(answer).data?.status === 'timeLimit',
    },
    async handler(request): Promise<SummaryResponse> {
      const role = request.principalRole;
      if (role !== 'administrator' && role !== 'investigator') throw new ExtensionRefusal({ code: 'ACCESS_DENIED' });
      const { caseSummarizer } = request;
      const body = summaryRequestSchema.parse(request.body);
      if (!caseSummarizer.availability().available) {
        await closeEarly(request, role, body, 'unavailable');
        throw new ExtensionRefusal({ code: 'ASK_UNSUPPORTED', reason: 'not-in-this-edition' });
      }
      const refs = { entities: body.entities, edges: body.edges, aggregates: body.aggregates, derived: body.derived };
      const elements = refs.entities.length + refs.edges.length + refs.aggregates.length + refs.derived.length;
      if (elements > caseSummarizer.maxElements) {
        await closeEarly(request, role, body, 'tooLarge');
        return { status: 'tooLarge', limit: 'elements', elements, cap: caseSummarizer.maxElements };
      }
      const { readElements } = gateClientOf(request);
      if (readElements === undefined) throw new ExtensionRefusal({ code: 'ASK_UNSUPPORTED', reason: 'not-in-this-edition' });
      let reading;
      try {
        reading = await readElements({ investigationId: body.investigationId, sourceId: body.sourceId, mask: body.mask === true }, refs);
      } catch (error) {
        await closeEarly(request, role, body, request.signal.aborted ? 'cancelled' : 'read-failed');
        throw error;
      }
      try {
        return await caseSummarizer.summarize({ actorId: request.principalId, actorRole: role, traceId: request.traceId, policyVersion: request.policyVersion?.(body.sourceId) ?? 'none', request: body, reading }, request.signal);
      } catch (error) {
        if (error instanceof AuditUnavailableError) throw new ExtensionRefusal({ code: 'AUDIT_UNAVAILABLE' });
        if (error instanceof SummaryHandled) throw error.handled;
        await closeEarly(request, role, body, request.signal.aborted ? 'cancelled' : 'error');
        throw error;
      }
    },
  };
}
