import { type AskEntities } from './ask.js';
import { entitiesOf, REPLY_MAX_CHARACTERS } from './ask-classify.js';
import { ASK_FOLDER_LIMITS, hasDuplicateKeys, isParameterName } from './ask-folder.js';
import { ASSISTANT_CLARIFICATION_MAX_CANDIDATES, ASSISTANT_MEANING_NAMES_MAX, ASSISTANT_MEANING_NAME_MAX, ASSISTANT_REFUSAL_CAUSES, type AssistantRefusalCause } from './assistant-turn.js';

export type AssistantRouterReply =
  | { readonly route: 'view' }
  /** The message asks only what named types or links mean: the names as the analyst wrote them, for the server to match and answer. */
  | { readonly route: 'meaning'; readonly types: readonly string[] }
  | { readonly route: 'refuse'; readonly cause: AssistantRefusalCause }
  | { readonly route: 'ask'; readonly intent: string; readonly entities: AskEntities; readonly elements?: Readonly<Record<string, string>> }
  | { readonly route: 'clarify'; readonly intent: string; readonly role: string; readonly entities: AskEntities; readonly elements?: Readonly<Record<string, string>>; readonly candidates: readonly string[] };

export type ReadAssistantRoute = { readonly ok: true; readonly reply: AssistantRouterReply } | { readonly ok: false };

const INTENT_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** The form of the key the server gives an element of the thread's context for one turn: `c` and a number. */
const ASSISTANT_CONTEXT_KEY = /^c[1-9][0-9]{0,3}$/;
const bad: ReadAssistantRoute = { ok: false };
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);
const hasExactly = (data: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean => {
  const own = Object.keys(data);
  return own.length === keys.length && keys.every((key) => key in data);
};

function candidatesOf(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length < 2 || value.length > ASSISTANT_CLARIFICATION_MAX_CANDIDATES) return undefined;
  const keys: string[] = [];
  for (const key of value) {
    if (typeof key !== 'string' || !ASSISTANT_CONTEXT_KEY.test(key) || keys.includes(key)) return undefined;
    keys.push(key);
  }
  return keys;
}

function elementsOf(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!isRecord(value)) return undefined;
  const elements: Record<string, string> = {};
  for (const role of Object.keys(value)) {
    const key = value[role];
    if (!isParameterName(role) || typeof key !== 'string' || !ASSISTANT_CONTEXT_KEY.test(key)) return undefined;
    elements[role] = key;
  }
  return elements;
}

/**
 * Reads the text of a reply of the router strictly: exactly one JSON object with a `route` of `view` (no other key), `refuse` (and a `cause` of the closed list) or `ask` (and an `intent` of
 * the name of an intent and its `entities`, and optionally `elements`, the roles whose value is a context key instead of typed text, never a role of `entities` too; whether the intent exists is for the route to say). Anything else, a duplicate key included, does not fit; nothing of the reply is repeated.
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
  if (route === 'meaning') {
    const types = data['types'];
    if (!hasExactly(data, ['route', 'types']) || !Array.isArray(types) || types.length < 1 || types.length > ASSISTANT_MEANING_NAMES_MAX) return bad;
    const names: string[] = [];
    for (const name of types) {
      if (typeof name !== 'string' || name.trim() === '' || [...name].length > ASSISTANT_MEANING_NAME_MAX || /[\u0000-\u001f\u007f-\u009f]/.test(name)) return bad;
      names.push(name);
    }
    return { ok: true, reply: { route, types: names } };
  }
  if (route === 'refuse') {
    const cause = data['cause'];
    const known = ASSISTANT_REFUSAL_CAUSES.find((candidate) => candidate === cause);
    return hasExactly(data, ['route', 'cause']) && known !== undefined ? { ok: true, reply: { route, cause: known } } : bad;
  }
  if (route === 'ask') {
    const intent = data['intent'];
    const entities = entitiesOf(data['entities']);
    const keyed = 'elements' in data;
    if (!hasExactly(data, keyed ? ['route', 'intent', 'entities', 'elements'] : ['route', 'intent', 'entities']) || typeof intent !== 'string' || !INTENT_NAME.test(intent) || entities === undefined) return bad;
    if (!keyed) return { ok: true, reply: { route, intent, entities } };
    const elements = elementsOf(data['elements']);
    if (elements === undefined || Object.keys(elements).length + Object.keys(entities).length > ASK_FOLDER_LIMITS.parameters || Object.keys(elements).some((role) => role in entities)) return bad;
    return { ok: true, reply: { route, intent, entities, elements } };
  }
  if (route === 'clarify') {
    const intent = data['intent'];
    const role = data['role'];
    const entities = entitiesOf(data['entities']);
    const keyed = 'elements' in data;
    const candidates = candidatesOf(data['candidates']);
    if (!hasExactly(data, keyed ? ['route', 'intent', 'role', 'entities', 'elements', 'candidates'] : ['route', 'intent', 'role', 'entities', 'candidates']) || typeof intent !== 'string' || !INTENT_NAME.test(intent)) return bad;
    if (typeof role !== 'string' || !isParameterName(role) || entities === undefined || candidates === undefined) return bad;
    const elements = keyed ? elementsOf(data['elements']) : {};
    if (elements === undefined) return bad;
    const taken = [...Object.keys(entities), ...Object.keys(elements)];
    if (taken.includes(role) || new Set(taken).size !== taken.length || taken.length + 1 > ASK_FOLDER_LIMITS.parameters) return bad;
    return { ok: true, reply: { route, intent, role, entities, ...(keyed ? { elements } : {}), candidates } };
  }
  return bad;
}
