import { ASK_ENTITY_TEXT_MAX_LENGTH, ASK_FOLDER_LIMITS, ASK_INTENT_NAME, ASK_SAVED_PATTERN_INTENT, ASSISTANT_CLARIFICATION_MAX_CANDIDATES, ASSISTANT_MEANING_NAMES_MAX, ASSISTANT_REFUSAL_CAUSES } from '@neburyx/contracts';
import { CLASSIFY_PROMPT_ID } from '../classify/classifier.js';
import { ROUTER_PROMPT_ID } from '../assistant/router.js';
import { MAX_SUMMARY_SENTENCES } from '../case-summary/instructions.js';

export type JsonSchema = Readonly<Record<string, unknown>>;

const SUMMARY_PROMPT_ID = 'case-summary';

const PARAMETER_NAME = '^[A-Za-z_][A-Za-z0-9_]{0,63}$';
const CONTEXT_KEY = '^c[1-9][0-9]{0,3}$';
const MEANING_NAME_MAX = 80;

const entities: JsonSchema = {
  type: 'object',
  propertyNames: { pattern: PARAMETER_NAME },
  additionalProperties: { type: 'string', minLength: 1, maxLength: ASK_ENTITY_TEXT_MAX_LENGTH },
  maxProperties: ASK_FOLDER_LIMITS.parameters,
};

const elements: JsonSchema = {
  type: 'object',
  propertyNames: { pattern: PARAMETER_NAME },
  additionalProperties: { type: 'string', pattern: CONTEXT_KEY },
  maxProperties: ASK_FOLDER_LIMITS.parameters,
};

const types: JsonSchema = { type: 'array', minItems: 1, maxItems: ASSISTANT_MEANING_NAMES_MAX, items: { type: 'string', minLength: 1, maxLength: MEANING_NAME_MAX } };
const intentName: JsonSchema = { type: 'string', pattern: ASK_INTENT_NAME.source };

/**
 * The reply form of the router as a JSON schema: the five route forms. The strict reader stays the only judge of a reply: the schema is looser where JSON schema cannot say what the reader does (a duplicate key, a role in both `entities` and `elements`, a total of
 * values over the limit, a candidate key given twice) and is never stricter than what the reader accepts.
 */
export function routerSchema(): JsonSchema {
  return {
    anyOf: [
      { type: 'object', properties: { route: { const: 'view' }, types, form: { const: 'table' } }, required: ['route'], additionalProperties: false },
      { type: 'object', properties: { route: { const: 'meaning' }, types }, required: ['route', 'types'], additionalProperties: false },
      { type: 'object', properties: { route: { const: 'refuse' }, cause: { enum: [...ASSISTANT_REFUSAL_CAUSES] } }, required: ['route', 'cause'], additionalProperties: false },
      { type: 'object', properties: { route: { const: 'ask' }, intent: intentName, entities, elements }, required: ['route', 'intent', 'entities'], additionalProperties: false },
      {
        type: 'object',
        properties: { route: { const: 'clarify' }, intent: intentName, role: { type: 'string', pattern: PARAMETER_NAME }, entities, elements, candidates: { type: 'array', minItems: 2, maxItems: ASSISTANT_CLARIFICATION_MAX_CANDIDATES, items: { type: 'string', pattern: CONTEXT_KEY } } },
        required: ['route', 'intent', 'role', 'entities', 'candidates'],
        additionalProperties: false,
      },
    ],
  };
}

/**
 * The reply form of Ask's classifier: an intent and its entities. This is the one place where a schema is stricter than the reader: the intent is one of the names given (the intents of the folders of the run, and the saved-pattern intent) or null, so that a name
 * outside them cannot be produced under the grammar, where the reader would answer `unknown-intent`.
 */
export function classificationSchema(intents: readonly string[]): JsonSchema {
  const names = [...new Set([...intents, ASK_SAVED_PATTERN_INTENT])].sort();
  return { type: 'object', properties: { intent: { enum: [...names, null] }, entities }, required: ['intent', 'entities'], additionalProperties: false };
}

/** The reply form of the summary's draft: its sentences, each with its text and the keys it cites, and optionally the names of the types that have no description. */
export function summarySchema(): JsonSchema {
  return {
    type: 'object',
    properties: {
      sentences: { type: 'array', maxItems: MAX_SUMMARY_SENTENCES, items: { type: 'object', properties: { text: { type: 'string', minLength: 1 }, cites: { type: 'array', items: { type: 'string', minLength: 1 } } }, required: ['text', 'cites'], additionalProperties: false } },
      noDescription: { type: 'array', items: { type: 'string' } },
    },
    required: ['sentences'],
    additionalProperties: false,
  };
}

export type EvalKind = 'ask' | 'assistant' | 'summary';

/** The schema a run of the given kind asks the server to constrain its replies to, by prompt id; `intents` are those of the folders of an Ask run. */
export function schemasOf(kind: EvalKind, intents: readonly string[]): Readonly<Record<string, JsonSchema>> {
  if (kind === 'ask') return { [CLASSIFY_PROMPT_ID]: classificationSchema(intents) };
  if (kind === 'assistant') return { [ROUTER_PROMPT_ID]: routerSchema() };
  return { [SUMMARY_PROMPT_ID]: summarySchema() };
}
