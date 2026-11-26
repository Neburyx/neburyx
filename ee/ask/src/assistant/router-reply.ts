import { REPLY_MAX_CHARACTERS, readAssistantRoute, type AssistantRouterReply } from '@neburyx/contracts';

/** The most characters of text a reply may hold before its route; the longest recorded reasoning is about 900. */
export const ROUTER_PREAMBLE_MAX_CHARACTERS = 2000;

export type RouterReplyRead = { readonly ok: true; readonly reply: AssistantRouterReply; /** The text of the reply that the product may keep. */ readonly kept: string } | { readonly ok: false };

/**
 * Reads a reply of the router: one route object, or text followed by one route object that is the whole of the last line. The text before it may hold no brace, so that no other object can stand in it, and it is never kept; the object itself is
 * judged by the strict reader, so no field of a route is guessed.
 */
export function readRouterReply(text: string): RouterReplyRead {
  const bare = readAssistantRoute(text);
  if (bare.ok) return { ok: true, reply: bare.reply, kept: text };
  if (text.length > REPLY_MAX_CHARACTERS) return { ok: false };
  const body = text.trimEnd();
  const at = body.lastIndexOf('\n');
  const before = body.slice(0, Math.max(at, 0)).trimEnd();
  const line = body.slice(at + 1);
  if (at < 0 || !line.startsWith('{') || /[{}]/.test(before) || [...before].length > ROUTER_PREAMBLE_MAX_CHARACTERS) return { ok: false };
  const read = readAssistantRoute(line);
  return read.ok ? { ok: true, reply: read.reply, kept: line } : { ok: false };
}
