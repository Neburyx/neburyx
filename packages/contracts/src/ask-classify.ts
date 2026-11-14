import { ASK_ENTITY_TEXT_MAX_LENGTH, type AskEntities, type AskRefusalCause } from './ask.js';
import { ASK_FOLDER_LIMITS, hasDuplicateKeys, isParameterName } from './ask-folder.js';
import { codePoints } from './investigations.js';

/** The sentence the person is told for each cause: fixed, so nothing the model, the question or the folder holds can reach the person through it. */
export const ASK_REFUSAL_SENTENCES: Readonly<Record<AskRefusalCause, string>> = {
  'no-intent': 'Ask has no way to answer this question.',
  'unknown-intent': 'Ask could not match this question to anything it can answer.',
  'bad-reply': 'Ask could not make sense of the answer it got for this question.',
  'model-declined': 'The assistant declined to work on this question.',
  'model-failed': 'The assistant is not available right now. Try again later.',
  'no-ask-for-source': 'Ask is not set up for this source.',
  unavailable: 'Ask is not available in this edition.',
  'missing-inputs': 'This question does not give everything Ask needs to answer it.',
  'extra-inputs': 'This question gives something Ask cannot use for this answer.',
  'invalid-inputs': 'The values in this question do not fit what Ask needs to answer it.',
  'nothing-found': 'Ask found nothing for this question.',
};

/** A reply longer than this is not read: a reply of the form is far shorter (20 entities of 256 characters and their keys), and a text written with escapes beyond this size is refused as one that does not fit. */
const REPLY_MAX_CHARACTERS = 100_000;

const CONTROL = /[\u0000-\u001F\u007F]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export type ReadClassification =
  | { readonly ok: true; readonly intent: string | null; readonly entities: AskEntities }
  | { readonly ok: false; readonly cause: Extract<AskRefusalCause, 'unknown-intent' | 'bad-reply'> };

const bad: ReadClassification = { ok: false, cause: 'bad-reply' };
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);

function entitiesOf(value: unknown): AskEntities | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length > ASK_FOLDER_LIMITS.parameters) return undefined;
  const entities: Record<string, string> = {};
  for (const key of keys) {
    const entity = value[key];
    if (!isParameterName(key) || typeof entity !== 'string') return undefined;
    const length = codePoints(entity);
    if (length === 0 || length > ASK_ENTITY_TEXT_MAX_LENGTH || CONTROL.test(entity) || LONE_SURROGATE.test(entity)) return undefined;
    entities[key] = entity;
  }
  return entities;
}

/**
 * Reads the text of a reply of the model strictly: exactly one JSON object (surrounding whitespace only) with exactly the keys `intent` and `entities`. `intent` is one of `allowedIntents`, or `null` when
 * none fits (then `entities` is empty). A name that is not allowed is `unknown-intent`; any other departure from the form is `bad-reply`. Nothing of the reply is repeated.
 */
export function readClassification(text: string, allowedIntents: readonly string[]): ReadClassification {
  if (text.length > REPLY_MAX_CHARACTERS) return bad;
  let data: unknown;
  try {
    if (hasDuplicateKeys(text)) return bad;
    data = JSON.parse(text);
  } catch {
    return bad;
  }
  if (!isRecord(data)) return bad;
  const keys = Object.keys(data);
  if (keys.length !== 2 || !('intent' in data) || !('entities' in data)) return bad;
  const entities = entitiesOf(data['entities']);
  if (entities === undefined) return bad;
  const intent = data['intent'];
  if (intent === null) return Object.keys(entities).length === 0 ? { ok: true, intent: null, entities } : bad;
  if (typeof intent !== 'string') return bad;
  return allowedIntents.includes(intent) ? { ok: true, intent, entities } : { ok: false, cause: 'unknown-intent' };
}
