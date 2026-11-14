import { z } from 'zod';
import { ASK_ENTITY_TEXT_MAX_LENGTH, ASK_QUESTION_MAX_CODE_POINTS, ASK_REFUSAL_CAUSES, ASK_SUMMARY_MAX_SENTENCE_LENGTH, askRunResultSchema, askSummarySchema, isHeavyResult } from './ask.js';
import { ASK_FOLDER_LIMITS, ASK_SAVED_PATTERN_INTENT, isParameterName } from './ask-folder.js';
import { savedPatternNameSchema } from './saved-pattern.js';
import { codePoints } from './investigations.js';

/** The label that opens the canonical text a run's parameters are signed under, so no other use of the signing capability signs the same text. */
export const ASK_RUN_PARAMS_LABEL = 'ask-run-params';
/** The label of the canonical text of a Continue token. */
export const ASK_CONTINUE_LABEL = 'ask-continue';
/** How long a Continue token holds after the answer that carried it, in milliseconds. */
export const ASK_CONTINUE_LIFETIME_MS = 15 * 60 * 1000;

const sourceId = z.string().min(1).max(200);
const intentName = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const names = z.array(z.string().min(1).max(64)).max(ASK_FOLDER_LIMITS.parameters);

/** The entities of a question: text, named as the parameters of the intent. */
export const askEntitiesSchema = z
  .record(z.string().min(1), z.string().min(1))
  .superRefine((entities, context) => {
    const keys = Object.keys(entities);
    if (keys.length > ASK_FOLDER_LIMITS.parameters) context.addIssue({ code: 'custom', message: `at most ${ASK_FOLDER_LIMITS.parameters} entities` });
    if (keys.some((key) => !isParameterName(key))) context.addIssue({ code: 'custom', message: 'an entity name is not a parameter name' });
    if (Object.values(entities).some((text) => codePoints(text) > ASK_ENTITY_TEXT_MAX_LENGTH)) context.addIssue({ code: 'custom', message: `an entity is at most ${ASK_ENTITY_TEXT_MAX_LENGTH} characters` });
  });

/** A Continue token: when it expires (milliseconds since the epoch) and the 64 hex characters of the HMAC. */
export const ASK_CONTINUE_TOKEN_PATTERN = /^[0-9]{1,16}\.[0-9a-f]{64}$/;

const questionText = z
  .string()
  .refine((text) => text.trim() !== '', { message: 'the question is not blank' })
  .refine((text) => codePoints(text) <= ASK_QUESTION_MAX_CODE_POINTS, { message: `at most ${ASK_QUESTION_MAX_CODE_POINTS} characters` })
  .meta({ maxLength: ASK_QUESTION_MAX_CODE_POINTS });

/** What `POST /v1/ask` takes: the typed question and the source it is asked in; `mask` as every read of the product. */
export const askQuestionRequestSchema = z.strictObject({ sourceId, question: questionText, mask: z.boolean().optional() });

/** What `POST /v1/ask/continue` takes: the intent and entities of an answer that stopped as heavy, and its token. */
export const askContinueRequestSchema = z.strictObject({ sourceId, intent: intentName, entities: askEntitiesSchema, continueToken: z.string().regex(ASK_CONTINUE_TOKEN_PATTERN), mask: z.boolean().optional() });

const outcome = z.enum(['complete', 'partial']);

const answeredSchema = z
  .strictObject({
    intent: intentName,
    entities: askEntitiesSchema,
    outcome,
    result: askRunResultSchema,
    summary: askSummarySchema.optional(),
    continueToken: z.string().regex(ASK_CONTINUE_TOKEN_PATTERN).optional(),
    /** The label of the saved pattern that ran, as its owner typed it; shown to the owner as data and never audited or logged. */
    patternName: savedPatternNameSchema.optional(),
  })
  .refine((answer) => answer.patternName === undefined || answer.intent === ASK_SAVED_PATTERN_INTENT, { message: 'only the answer of a saved pattern names a pattern', path: ['patternName'] })
  .refine((answer) => isHeavyResult(answer.result) === (answer.continueToken !== undefined), { message: 'a heavy result comes with a continue token and no other result does', path: ['continueToken'] })
  .refine((answer) => !(isHeavyResult(answer.result) && answer.summary !== undefined), { message: 'a result that stopped as heavy lists nothing to cite and has no summary', path: ['summary'] });

/**
 * A refusal of the question: the cause and its fixed sentence, and, when the intent is known, the names of the intent's inputs and of the ones found, missing and extra. The names and the entities of an answer are data
 * the person typed or the model named, shown as data; no field holds free text of the model.
 */
const refusedSchema = z.strictObject({
  cause: z.enum(ASK_REFUSAL_CAUSES),
  sentence: z.string().min(1).max(ASK_SUMMARY_MAX_SENTENCE_LENGTH),
  intent: intentName.optional(),
  parameters: names.optional(),
  found: names.optional(),
  missing: names.optional(),
  extra: names.optional(),
});

/** What both routes answer: the answered question with its result, or the refusal with its cause. */
export const askAnswerSchema = z.union([z.strictObject({ answered: answeredSchema }), z.strictObject({ refused: refusedSchema })]);

export type AskQuestionRequest = z.infer<typeof askQuestionRequestSchema>;
export type AskContinueRequest = z.infer<typeof askContinueRequestSchema>;
export type AskAnswer = z.infer<typeof askAnswerSchema>;
