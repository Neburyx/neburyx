import { ASK_PLAN_TEMPLATE_IDS } from './ask.js';
import { checkIntentQuery } from './query-check.js';
import { checkTemplateSettings } from './ask-bind.js';

/** The limits of the files of an Ask folder: working limits, not taken from a source. */
export const ASK_FOLDER_LIMITS = {
  classificationBytes: 64 * 1024,
  intentsBytes: 1024 * 1024,
  intents: 200,
  queryBytes: 8 * 1024,
  parameters: 20,
} as const;

/** The name of the saved-pattern intent, which the product itself provides; a file may not use it. */
export const ASK_SAVED_PATTERN_INTENT = 'saved-pattern';

/** The name of an intent: a letter, then letters, digits, `_` and `-`, at most 64 characters. */
export const ASK_INTENT_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const INTENT_NAME = ASK_INTENT_NAME;

const PARAMETER_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const TEMPLATE_IDS: readonly string[] = ASK_PLAN_TEMPLATE_IDS;

/** An intent as the file states it, before the loader adds the hash of its query. */
export type ParsedAskIntent =
  | { readonly name: string; readonly parameters: readonly string[]; readonly kind: 'query'; readonly query: string }
  | { readonly name: string; readonly parameters: readonly string[]; readonly kind: 'template'; readonly template: string; readonly settings: Readonly<Record<string, unknown>> };

/** An intent of the loaded folder. A query's hash is the SHA-256 of its exact UTF-8 text; the audit of a run can name it. */
export type AskIntent =
  | { readonly name: string; readonly parameters: readonly string[]; readonly kind: 'query'; readonly query: { readonly text: string; readonly sha256: string } }
  | { readonly name: string; readonly parameters: readonly string[]; readonly kind: 'template'; readonly template: string; readonly settings: Readonly<Record<string, unknown>> };

/** What the folder holds for one source: the classification text (with the SHA-256 of the file's bytes) and the intents in file order. */
export interface AskSourceFolder {
  readonly classification: { readonly text: string; readonly sha256: string };
  readonly intents: readonly AskIntent[];
}

/** The folder read once at start-up. A source without a subfolder has no entry. */
export interface AskFolder {
  readonly sourceIds: readonly string[];
  readonly source: (sourceId: string) => AskSourceFolder | undefined;
  /** One intent of a source by its name, or undefined. */
  readonly intent: (sourceId: string, name: string) => AskIntent | undefined;
}

export type ParsedIntents = { readonly ok: true; readonly intents: readonly ParsedAskIntent[] } | { readonly ok: false; readonly problems: readonly string[] };

const PLAIN_KEY = /^[A-Za-z0-9_.-]{1,64}$/;

/** The rule for the name of a parameter, and of an entity the classifier names. */
export const isParameterName = (name: string): boolean => PARAMETER_NAME.test(name) && name !== '__proto__';

/**
 * Whether any object of a JSON text holds the same key twice: `JSON.parse` keeps the last of two equal keys and says nothing, so the text is walked once more. The walk is iterative, so a deep text costs no stack.
 */
export function hasDuplicateKeys(text: string): boolean {
  const frames: ({ readonly keys: Set<string>; expectKey: boolean } | 'array')[] = [];
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    const top = frames[frames.length - 1];
    if (char === '"') {
      let end = at + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      if (top !== undefined && top !== 'array' && top.expectKey) {
        try {
          const key: unknown = JSON.parse(text.slice(at, end + 1));
          if (typeof key === 'string') {
            if (top.keys.has(key)) return true;
            top.keys.add(key);
          }
        } catch {
          // a string that does not parse was refused by JSON.parse already
        }
        top.expectKey = false;
      }
      at = end;
    } else if (char === '{') frames.push({ keys: new Set(), expectKey: true });
    else if (char === '[') frames.push('array');
    else if (char === '}' || char === ']') frames.pop();
    else if (char === ',' && top !== undefined && top !== 'array') top.expectKey = true;
  }
  return false;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);
const byteLength = (text: string): number => new TextEncoder().encode(text).length;

function parametersOf(name: string, value: unknown, problems: string[]): readonly string[] {
  if (!Array.isArray(value)) {
    problems.push(`intent "${name}": parameters must be a list of names`);
    return [];
  }
  const names: string[] = [];
  for (const entry of value as readonly unknown[]) {
    if (typeof entry !== 'string' || !isParameterName(entry)) problems.push(`intent "${name}": a parameter name is not [A-Za-z_][A-Za-z0-9_]{0,63}`);
    else if (names.includes(entry)) problems.push(`intent "${name}": a parameter is listed twice`);
    else names.push(entry);
  }
  if (value.length > ASK_FOLDER_LIMITS.parameters) problems.push(`intent "${name}": more than ${ASK_FOLDER_LIMITS.parameters} parameters`);
  return names;
}

/**
 * Reads the text of an intents file: `{ "<intent>": { "parameters": [..], "query": "<text>" } }` or `{ "parameters": [..], "template": "<id>", "settings": {..} }`, exactly one of `query` and `template`.
 * Every problem names the intent and what is wrong, and none repeats a value of the file. A query is checked by `checkIntentQuery`.
 */
function deepFreeze<T extends object>(value: T): T {
  for (const inner of Object.values(value)) if (typeof inner === 'object' && inner !== null) deepFreeze(inner);
  return Object.freeze(value);
}

export function parseIntentsFile(text: string): ParsedIntents {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, problems: ['the file is not valid JSON'] };
  }
  if (!isRecord(data)) return { ok: false, problems: ['the file must be one object with an intent for each key'] };
  const names = Object.keys(data);
  if (hasDuplicateKeys(text)) return { ok: false, problems: ['a key is used twice in an object of the file'] };
  if (names.length === 0) return { ok: false, problems: ['the file names no intent'] };
  if (names.length > ASK_FOLDER_LIMITS.intents) return { ok: false, problems: [`the file names more than ${ASK_FOLDER_LIMITS.intents} intents`] };
  const problems: string[] = [];
  const intents: ParsedAskIntent[] = [];
  for (const name of names) {
    const entry = data[name];
    if (!INTENT_NAME.test(name)) {
      problems.push('an intent name is not [A-Za-z][A-Za-z0-9_-]{0,63}');
      continue;
    }
    if (name === ASK_SAVED_PATTERN_INTENT) {
      problems.push(`intent "${name}": the name is reserved for the saved patterns`);
      continue;
    }
    if (!isRecord(entry)) {
      problems.push(`intent "${name}": must be an object`);
      continue;
    }
    for (const key of Object.keys(entry)) {
      if (!['parameters', 'query', 'template', 'settings'].includes(key)) problems.push(`intent "${name}": ${PLAIN_KEY.test(key) ? `the key ${key}` : 'a key'} is not known`);
    }
    const before = problems.length;
    const parameters = parametersOf(name, entry['parameters'], problems);
    const hasQuery = 'query' in entry;
    const hasTemplate = 'template' in entry;
    if (hasQuery === hasTemplate) {
      problems.push(`intent "${name}": give exactly one of query and template`);
      continue;
    }
    if (hasQuery) {
      const query = entry['query'];
      if ('settings' in entry) problems.push(`intent "${name}": settings belong to a template`);
      if (typeof query !== 'string' || query.trim() === '') problems.push(`intent "${name}": the query must be text`);
      else if (byteLength(query) > ASK_FOLDER_LIMITS.queryBytes) problems.push(`intent "${name}": the query is longer than ${ASK_FOLDER_LIMITS.queryBytes} bytes`);
      else {
        problems.push(...checkIntentQuery({ intent: name, query, parameters }));
        if (problems.length === before) intents.push({ name, parameters, kind: 'query', query });
      }
      continue;
    }
    const template = entry['template'];
    const settings = entry['settings'] ?? {};
    if (typeof template !== 'string' || !TEMPLATE_IDS.includes(template)) problems.push(`intent "${name}": the template is not one of ${TEMPLATE_IDS.join(', ')}`);
    else if (!isRecord(settings)) problems.push(`intent "${name}": settings must be an object`);
    else {
      problems.push(...checkTemplateSettings({ intent: name, template, parameters, settings }));
      if (problems.length === before) intents.push({ name, parameters, kind: 'template', template, settings });
    }
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, intents: intents.map((intent) => deepFreeze(intent)) };
}
