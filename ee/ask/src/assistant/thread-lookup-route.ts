import { ASSISTANT_CHAT_LOOKUP_IDS_MAX, ExtensionRefusal, assistantChatLookupRequestSchema, assistantChatLookupResponseSchema, type AssistantChatLookupRequest, type AssistantChatLookupResponse, type ExtensionLogger, type ExtensionRequest, type ExtensionRoute } from '@neburyx/contracts';
import type { AssistantThreadStore } from './thread-store.js';

const LOOKUP_URL = '/v1/assistant/threads/lookup';
const LOOKUP_FAILED = 'assistant-thread.lookup-failed';

export interface ThreadLookupRouteOptions {
  readonly threads: () => AssistantThreadStore | undefined;
  readonly logger: () => ExtensionLogger | undefined;
}

/**
 * Which of the named investigations the caller has a chat for. The application names which of them the caller's investigations list would show (`chatInvestigations`: open, not deleted, the caller's own, on a source the caller may read), the caller's own thread rows
 * are asked for those and only for those, and the answer is their ids in the order asked: a chat of a person is the thread row of that person, as the list of chats counts it, whatever its number of turns. Ids only; nothing of the source is read.
 */
export function createAssistantThreadLookupRoute(options: ThreadLookupRouteOptions): ExtensionRoute {
  return {
    method: 'POST',
    url: LOOKUP_URL,
    permission: 'principal',
    requestSchema: assistantChatLookupRequestSchema,
    responseSchema: assistantChatLookupResponseSchema,
    async handler(request: ExtensionRequest): Promise<AssistantChatLookupResponse> {
      const store = options.threads();
      const { chatInvestigations } = request;
      if (store === undefined || chatInvestigations === undefined) throw new ExtensionRefusal({ code: 'ASK_UNSUPPORTED', reason: 'not-in-this-edition' });
      // the application has read the body through the route's schema before the handler runs
      const { investigationIds } = request.body as AssistantChatLookupRequest;
      try {
        const named = new Set((await chatInvestigations(investigationIds.slice(0, ASSISTANT_CHAT_LOOKUP_IDS_MAX))).map((each) => each.id.toLowerCase()));
        const shown = investigationIds.filter((id) => named.has(id.toLowerCase()));
        const held = new Set((shown.length === 0 ? [] : await store.withThreads(request.principalId, shown)).map((id) => id.toLowerCase()));
        return { withChat: shown.filter((id) => held.has(id.toLowerCase())) };
      } catch (error) {
        if (error instanceof ExtensionRefusal) throw error;
        try {
          options.logger()?.warn({ event: LOOKUP_FAILED }, 'the chats of a person could not be looked up');
        } catch {
          // a logger that fails changes nothing
        }
        throw new Error('the chats of a person could not be looked up');
      }
    },
  };
}
