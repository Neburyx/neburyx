import { createHash, timingSafeEqual } from 'node:crypto';
import {
  CHAT_INVESTIGATION_IDS_MAX,
  CHAT_LAST_QUESTION_MAX,
  CHAT_LIST_DEFAULT_LIMIT,
  CHAT_LIST_MAX_LIMIT,
  CHAT_LIST_SCAN_CAP,
  ExtensionRefusal,
  assistantThreadListQuerySchema,
  assistantThreadListResponseSchema,
  type AssistantThreadListResponse,
  type ChatInvestigation,
  type ExtensionLogger,
  type ExtensionRequest,
  type ExtensionRoute,
} from '@neburyx/contracts';
import { z } from 'zod';
import type { AssistantThreadStore, ThreadListPosition, ThreadListRow } from './thread-store.js';

const LIST_URL = '/v1/assistant/threads';
const LIST_FAILED = 'assistant-thread.list-failed';

const positionSchema = z.strictObject({ p: z.string(), s: z.string(), k: z.string(), i: z.string() });

const cut = (text: string): string => {
  const points = [...text];
  return points.length <= CHAT_LAST_QUESTION_MAX ? text : points.slice(0, CHAT_LAST_QUESTION_MAX).join('');
};

const searchKeyOf = (text: string | undefined): string => createHash('sha256').update(text?.toLowerCase() ?? '').digest('hex');

/** What a cursor of the list is made for: the caller and the search. The policy is not bound: the application decides on every page which investigations the caller may see, so a cursor never carries an access decision. */
interface Binding {
  readonly principal: string;
  readonly search: string;
}

function mint(sign: (text: string) => string, binding: Binding, position: ThreadListPosition): string {
  const payload = JSON.stringify({ p: binding.principal, s: binding.search, k: position.key, i: position.id });
  return `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
}

/** The position a cursor holds, or undefined for one that was not made by this application for this caller, this search and this policy version. */
function verify(sign: (text: string) => string, binding: Binding, cursor: string): ThreadListPosition | undefined {
  const [encoded, signature, ...rest] = cursor.split('.');
  if (encoded === undefined || signature === undefined || rest.length > 0) return undefined;
  let payload: string;
  try {
    payload = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return undefined;
  }
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
  let held: z.infer<typeof positionSchema>;
  try {
    held = positionSchema.parse(JSON.parse(payload));
  } catch {
    return undefined;
  }
  return held.p === binding.principal && held.s === binding.search ? { key: held.k, id: held.i } : undefined;
}

function itemOf(row: ThreadListRow, named: ChatInvestigation) {
  return {
    investigationId: named.id,
    title: named.title,
    caseRef: named.caseRef,
    sourceId: named.sourceId,
    sourceAlias: named.sourceAlias,
    sourceState: named.sourceState,
    lastQuestionAt: row.lastTurnAt,
    turns: row.turns,
    lastQuestion: row.lastQuestion === null ? null : cut(row.lastQuestion),
  };
}

export interface ThreadListRouteOptions {
  readonly threads: () => AssistantThreadStore | undefined;
  readonly logger: () => ExtensionLogger | undefined;
}

/**
 * The caller's own chats, newest last question first. The threads are read in chunks from the application's own tables and the application names which of their investigations the caller's list would show (`chatInvestigations`), with the title
 * and the source state it shows; a thread whose investigation it does not name is dropped. A search keeps the chats whose shown title or whose full stored question holds the text, as plain text. A request reads at most `CHAT_LIST_SCAN_CAP` threads:
 * a page that reaches it before it is full is returned short with a cursor. The cursor is signed with the application's key and bound to the caller and the search. Nothing of the source is read.
 */
export function createAssistantThreadListRoute(options: ThreadListRouteOptions): ExtensionRoute {
  return {
    method: 'GET',
    url: LIST_URL,
    permission: 'principal',
    query: assistantThreadListQuerySchema,
    responseSchema: assistantThreadListResponseSchema,
    async handler(request: ExtensionRequest): Promise<AssistantThreadListResponse> {
      const store = options.threads();
      const { chatInvestigations, signText } = request;
      if (store === undefined || chatInvestigations === undefined || signText === undefined) throw new ExtensionRefusal({ code: 'ASK_UNSUPPORTED', reason: 'not-in-this-edition' });
      // the application has read the query through the route's schema before the handler runs
      const query = (request.query ?? {}) as z.output<typeof assistantThreadListQuerySchema>;
      const limit = query.limit ?? CHAT_LIST_DEFAULT_LIMIT;
      if (limit < 1) throw new ExtensionRefusal({ code: 'INVALID_REQUEST', reason: 'invalid-request' });
      if (limit > CHAT_LIST_MAX_LIMIT) throw new ExtensionRefusal({ code: 'QUERY_BUDGET_EXCEEDED', maxPage: CHAT_LIST_MAX_LIMIT });
      const binding: Binding = { principal: request.principalId, search: searchKeyOf(query.q) };
      let after: ThreadListPosition | undefined;
      if (query.cursor !== undefined) {
        after = verify(signText, binding, query.cursor);
        if (after === undefined) throw new ExtensionRefusal({ code: 'CURSOR_INVALIDATED' });
      }
      const needle = query.q?.toLowerCase();
      try {
        const items: ReturnType<typeof itemOf>[] = [];
        let scanned = 0;
        let lastPosition: ThreadListPosition | undefined = after;
        let pageEnd: ThreadListPosition | undefined;
        let exhausted = false;
        while (scanned < CHAT_LIST_SCAN_CAP && items.length <= limit && !exhausted) {
          const size = Math.min(CHAT_INVESTIGATION_IDS_MAX, CHAT_LIST_SCAN_CAP - scanned);
          const chunk = await store.listOwn(request.principalId, lastPosition, size);
          const named = new Map((await chatInvestigations(chunk.map((row) => row.investigationId))).map((each) => [each.id.toLowerCase(), each]));
          for (const row of chunk) {
            scanned += 1;
            lastPosition = { key: row.key, id: row.threadId };
            const found = named.get(row.investigationId.toLowerCase());
            if (found === undefined) continue;
            if (needle !== undefined && !found.title.toLowerCase().includes(needle) && !(row.lastQuestion ?? '').toLowerCase().includes(needle)) continue;
            if (items.length === limit) {
              // one match more than the page: the page ends at the last item it holds
              items.push(itemOf(row, found));
              break;
            }
            items.push(itemOf(row, found));
            pageEnd = lastPosition;
          }
          exhausted = chunk.length < size;
        }
        const more = items.length > limit;
        const page = items.slice(0, limit);
        const nextPosition = more ? pageEnd : exhausted ? undefined : lastPosition;
        return { items: page, nextCursor: nextPosition === undefined ? null : mint(signText, binding, nextPosition) };
      } catch (error) {
        if (error instanceof ExtensionRefusal) throw error;
        try {
          options.logger()?.warn({ event: LIST_FAILED }, 'the chats of a person could not be listed');
        } catch {
          // a logger that fails changes nothing
        }
        throw new Error('the chats of a person could not be listed');
      }
    },
  };
}
