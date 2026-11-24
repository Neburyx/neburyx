import { ExtensionRefusal, type AuditEvent, assistantThreadClearRequestSchema, assistantThreadClearResponseSchema, copyToNotesParamsSchema, type AssistantThreadClearResponse, type ExtensionLogger, type ExtensionRequest, type ExtensionRoute } from '@neburyx/contracts';
import type { AssistantThreadStore } from './thread-store.js';

const CLEAR_URL = '/v1/assistant/investigations/:id/thread/clear';
const CLEAR_FAILED = 'assistant-thread.clear-failed';
const THREAD_CLEAR_ACTION = 'assistant.thread.cleared';

/** The event of a clearing: who, where and when (the application stamps the time), and for a success only whether a thread was deleted; never a text, a count of turns, a hash or a run id. */
async function writeEvent(request: ExtensionRequest, investigation: { readonly id: string; readonly sourceId: string }, result: AuditEvent['result'], cleared?: boolean): Promise<void> {
  const event: AuditEvent = {
    actorId: request.principalId,
    actorRole: request.principalRole,
    action: THREAD_CLEAR_ACTION,
    result,
    sourceId: investigation.sourceId,
    investigationId: investigation.id,
    traceId: request.traceId,
    ...(cleared === undefined ? {} : { detail: { threadClear: { cleared } } }),
  };
  // the application queues the event and counts and logs its own failures; a failure here does not change the answer
  await request.audit.record(event).catch(() => undefined);
}

export interface ThreadClearRouteOptions {
  readonly threads: () => AssistantThreadStore | undefined;
  readonly logger: () => ExtensionLogger | undefined;
}

/**
 * Clears the caller's own thread of one of their investigations and the text of the model calls of their runs of it. The investigation is the caller's or the answer is `NOT_FOUND` before the handler runs, and the thread is found by the caller's own id, so another person's thread is never touched.
 * Nothing of the source is read. A store that fails ends in the application's fixed `INTERNAL_ERROR`, nothing is deleted, and the log holds the investigation's id only.
 */
export function createAssistantThreadClearRoute(options: ThreadClearRouteOptions): ExtensionRoute {
  return {
    method: 'POST',
    url: CLEAR_URL,
    permission: 'principal',
    params: copyToNotesParamsSchema,
    requestSchema: assistantThreadClearRequestSchema,
    investigation: { param: 'id', missing: 'NOT_FOUND' },
    responseSchema: assistantThreadClearResponseSchema,
    async handler(request: ExtensionRequest): Promise<AssistantThreadClearResponse> {
      const { investigation } = request;
      const store = options.threads();
      if (investigation === undefined || store === undefined) throw new ExtensionRefusal({ code: 'ASK_UNSUPPORTED', reason: 'not-in-this-edition' });
      try {
        const cleared = await store.clearOwn(investigation.id, request.principalId);
        await writeEvent(request, investigation, 'success', cleared);
        return { cleared };
      } catch {
        await writeEvent(request, investigation, 'failed');
        try {
          options.logger()?.warn({ event: CLEAR_FAILED, investigationId: investigation.id }, 'the thread of an investigation could not be cleared');
        } catch {
          // a logger that fails changes nothing
        }
        throw new Error('the thread of an investigation could not be cleared');
      }
    },
  };
}
