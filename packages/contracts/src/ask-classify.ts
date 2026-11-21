import { ASK_ENTITY_TEXT_MAX_LENGTH, type AskEntities, type AskRefusalCause, type AskValueNotFitKind } from './ask.js';
import { ASK_FOLDER_LIMITS, hasDuplicateKeys, isParameterName } from './ask-folder.js';
import { codePoints } from './investigations.js';

/** The sentence the person is told for each cause: fixed, so nothing the model, the question or the folder holds can reach the person through it. */
export const ASK_REFUSAL_SENTENCES: Readonly<Record<AskRefusalCause, string>> = {
  'no-intent': 'This question does not match any question type this source offers.',
  'unknown-intent': 'Ask picked a question type this source does not have. Nothing was run.',
  'bad-reply': 'Ask could not use the model’s reply, so nothing was run.',
  'model-declined': 'The model declined this question. Nothing was run.',
  'model-failed': 'The model could not process this question. Nothing was run.',
  'no-ask-for-source': 'Ask is not set up for this source.',
  unavailable: 'Ask is not available right now.',
  'missing-inputs': 'This question needs a value Ask could not find.',
  'extra-inputs': 'This question has a value this question type does not use.',
  'invalid-inputs': 'A value in this question is not valid for this question type.',
  'nothing-found': 'The question ran and nothing in this source matches.',
  'value-not-fit': 'A value in this question is not the kind of element this question needs. Nothing was run.',
};

const withArticle = (type: string): string => `${/^[aeiou]/i.test(type) ? 'an' : 'a'} ${type}`;

/**
 * The fixed sentence of a value that does not fit the type its role needs, built from the type the question needs and, for another type, the type found and the title the gate gave the element (masked when the
 * request masks). `hidden` says nothing about whether an element exists. No word of the model or of the question's text is in it.
 */
export function valueNotFitSentence(fit: { readonly kind: AskValueNotFitKind; readonly needed: string; readonly found?: string | undefined; readonly title?: string | undefined; readonly laterStep?: boolean | undefined }): string {
  // a step of a tool loop that came after reads that did run: what was run before stands, and only this step was not run
  const ending = fit.laterStep === true ? 'That step was not run; the results above stand.' : 'Nothing was run.';
  if (fit.kind === 'other-type' && fit.found !== undefined && fit.title !== undefined) return `${fit.title} is ${withArticle(fit.found)}; this question needs ${withArticle(fit.needed)}. ${ending}`;
  if (fit.kind === 'not-found') return `There is no ${fit.needed} with that id. ${ending}`;
  return `That value does not give ${withArticle(fit.needed)} this question can use. ${ending}`;
}

/** A reply longer than this is not read: a reply of the form is far shorter (20 entities of 256 characters and their keys), and a text written with escapes beyond this size is refused as one that does not fit. */
export const REPLY_MAX_CHARACTERS = 100_000;

const CONTROL = /[\u0000-\u001F\u007F]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export type ReadClassification =
  | { readonly ok: true; readonly intent: string | null; readonly entities: AskEntities }
  | { readonly ok: false; readonly cause: Extract<AskRefusalCause, 'unknown-intent' | 'bad-reply'> };

const bad: ReadClassification = { ok: false, cause: 'bad-reply' };
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function entitiesOf(value: unknown): AskEntities | undefined {
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

/** What the model is told, after the question, of the caller's saved patterns: how to name one and when a starting entity is needed. The catalog text follows it. */
export const ASK_SAVED_PATTERN_NOTE =
  'Saved patterns of the signed-in person, each with a key. To run one, answer with the intent "saved-pattern" and the entity "pattern" holding its key; a pattern that starts from an entity the question gives also needs the entity "anchor" holding that entity\'s stable ID.';
