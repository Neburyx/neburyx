import { ExtensionRefusal, assistantThreadResponseSchema, copyToNotesParamsSchema, type AssistantThreadResponse, type ExtensionLogger, type ExtensionRequest, type ExtensionRoute } from '@neburyx/contracts';
import { z } from 'zod';
import { presentThread } from './thread-present.js';
import type { AssistantThreadStore } from './thread-store.js';

/** Whether the caller's mask is on for this read: `mask=true`; absent or `false` is off. */
const threadQuerySchema = z.strictObject({ mask: z.enum(['true', 'false']).optional() });

const THREAD_URL = '/v1/assistant/investigations/:id/thread';
const THREAD_READ_FAILED = 'assistant-thread.read-failed';

export interface ThreadRouteOptions {
  readonly threads: () => AssistantThreadStore | undefined;
  /** How many of the most recent turns one read gives. */
  readonly limit: () => number;
  readonly logger: () => ExtensionLogger | undefined;
}

/**
 * The caller's own thread of one of their investigations: what kind of turn each was and how it ended, never a hash, a reference, a token or a run id. The investigation is the caller's or the answer is `NOT_FOUND`
 * before the handler runs, and the thread is found by the caller's own id, so another person's thread is never read. A store that cannot read ends in the application's fixed `INTERNAL_ERROR`, and the log holds the investigation's id only.
 */
export function createAssistantThreadRoute(options: ThreadRouteOptions): ExtensionRoute {
  return {
    method: 'GET',
    url: THREAD_URL,
    permission: 'principal',
    params: copyToNotesParamsSchema,
    query: threadQuerySchema,
    investigation: { param: 'id', missing: 'NOT_FOUND' },
    responseSchema: assistantThreadResponseSchema,
    async handler(request: ExtensionRequest): Promise<AssistantThreadResponse> {
      const { investigation } = request;
      const store = options.threads();
      if (investigation === undefined || store === undefined) throw new ExtensionRefusal({ code: 'ASK_UNSUPPORTED', reason: 'not-in-this-edition' });
      try {
        const maskNow = (request.query as z.infer<typeof threadQuerySchema> | undefined)?.mask === 'true';
        const read = await store.read(investigation.id, request.principalId, options.limit());
        let version: string | undefined;
        try {
          version = request.sensitivityVersion?.(investigation.sourceId);
        } catch {
          version = undefined;
        }
        return presentThread(read, maskNow, version);
      } catch {
        try {
          options.logger()?.warn({ event: THREAD_READ_FAILED, investigationId: investigation.id }, 'the thread of an investigation could not be read');
        } catch {
          // a logger that fails changes nothing
        }
        // an error that is not a refusal of the product is answered by the application as the fixed `INTERNAL_ERROR`, with no text of it
        throw new Error('the thread of an investigation could not be read');
      }
    },
  };
}
