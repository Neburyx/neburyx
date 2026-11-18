import { type AskEntities } from './ask.js';
import { entitiesOf, REPLY_MAX_CHARACTERS } from './ask-classify.js';
import { hasDuplicateKeys } from './ask-folder.js';
import { ASSISTANT_REFUSAL_CAUSES, type AssistantRefusalCause } from './assistant-turn.js';

export type AssistantRouterReply =
  | { readonly route: 'view' }
  | { readonly route: 'refuse'; readonly cause: AssistantRefusalCause }
  | { readonly route: 'ask'; readonly intent: string; readonly entities: AskEntities };

export type ReadAssistantRoute = { readonly ok: true; readonly reply: AssistantRouterReply } | { readonly ok: false };

const INTENT_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const bad: ReadAssistantRoute = { ok: false };
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);
const hasExactly = (data: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean => {
  const own = Object.keys(data);
  return own.length === keys.length && keys.every((key) => key in data);
};

/**
 * Reads the text of a reply of the router strictly: exactly one JSON object with a `route` of `view` (no other key), `refuse` (and a `cause` of the closed list) or `ask` (and an `intent` of
 * the name of an intent and its `entities`; whether the intent exists is for the route to say). Anything else, a duplicate key included, does not fit; nothing of the reply is repeated.
 */
export function readAssistantRoute(text: string): ReadAssistantRoute {
  if (text.length > REPLY_MAX_CHARACTERS) return bad;
  let data: unknown;
  try {
    if (hasDuplicateKeys(text)) return bad;
    data = JSON.parse(text);
  } catch {
    return bad;
  }
  if (!isRecord(data)) return bad;
  const route = data['route'];
  if (route === 'view') return hasExactly(data, ['route']) ? { ok: true, reply: { route } } : bad;
  if (route === 'refuse') {
    const cause = data['cause'];
    const known = ASSISTANT_REFUSAL_CAUSES.find((candidate) => candidate === cause);
    return hasExactly(data, ['route', 'cause']) && known !== undefined ? { ok: true, reply: { route, cause: known } } : bad;
  }
  if (route === 'ask') {
    const intent = data['intent'];
    const entities = entitiesOf(data['entities']);
    if (!hasExactly(data, ['route', 'intent', 'entities']) || typeof intent !== 'string' || !INTENT_NAME.test(intent) || entities === undefined) return bad;
    return { ok: true, reply: { route, intent, entities } };
  }
  return bad;
}
