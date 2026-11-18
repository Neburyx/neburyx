import { z } from 'zod';
import { SUMMARY_DEFAULTS } from './ai.js';
import { askAnswerSchema, askContinueRequestSchema } from './ask-question.js';
import { edgeRefSchema, elementRefSchema } from './graph.js';
import { summarySentenceSchema } from './summary.js';

const text = z.string().min(1);

/** The most keys of the elements in view that one turn carries: the summary's cap. */
export const ASSISTANT_VIEW_KEYS_MAX = SUMMARY_DEFAULTS.maxElements;

/** `POST /v1/assistant/turns`: a message as typed, and the keys of the elements in view, never their content. */
const turnBase = { sourceId: text, investigationId: text, mask: z.boolean().optional(), viewElementKeys: z.array(text).max(ASSISTANT_VIEW_KEYS_MAX) };

/** A turn is a message, or the continue of a heavy stop (the intent, the entities and the token of the answer that stopped), never both: two forms, so the published schema says so. */
export const assistantTurnRequestSchema = z.union([
  z.strictObject({ ...turnBase, message: text }),
  z.strictObject({ ...turnBase, continue: askContinueRequestSchema.pick({ intent: true, entities: true, continueToken: true }) }),
]);

export type AssistantTurnRequest = z.infer<typeof assistantTurnRequestSchema>;

/** Why the router refused a message; the sentence is chosen by the server from the cause, never by the model. */
export const ASSISTANT_REFUSAL_CAUSES = ['verdict', 'raw-query', 'other-source', 'unplaced'] as const;
export type AssistantRefusalCause = (typeof ASSISTANT_REFUSAL_CAUSES)[number];

export const ASSISTANT_REFUSAL_SENTENCES: Readonly<Record<AssistantRefusalCause, string>> = {
  verdict: 'I can’t judge guilt or intent. I can show what the investigation connects.',
  'raw-query': 'I can’t run query text. Ask in your own words, or use the manual tools.',
  'other-source': 'I can only work with the source of this investigation.',
  unplaced: 'I can’t place this message. Rephrase it, or use the manual tools.',
};

export const ASSISTANT_NOT_ANSWERED_SENTENCE = 'I can’t support an answer from this investigation.';

export const ASSISTANT_FAILURE_KINDS = ['service', 'source-unavailable', 'busy', 'timeout', 'rate-limit'] as const;
export type AssistantFailureKind = (typeof ASSISTANT_FAILURE_KINDS)[number];

export const ASSISTANT_TOO_LARGE_SENTENCE = 'The message and the view are too large to send. Narrow the view or ask something smaller.';

export const ASSISTANT_CONTINUE_INVALID_SENTENCE = 'This continue is no longer valid. Nothing was read.';

export const assistantTurnAnswerSchema = z.union([
  z.strictObject({
    status: z.literal('answered'),
    route: z.literal('refuse'),
    cause: z.enum(ASSISTANT_REFUSAL_CAUSES),
    sentence: text,
  }),
  z.strictObject({ status: z.literal('not-answered'), route: z.literal('view'), sentence: text }),
  /** A failure of the model's service; `readStarted` is false when no read of the source began, and `retryAfterSeconds` is present only when the service said how long to wait. */
  z.strictObject({ status: z.literal('unavailable'), kind: z.enum(ASSISTANT_FAILURE_KINDS), readStarted: z.boolean(), retryAfterSeconds: z.number().int().positive().optional() }),
  z.strictObject({ status: z.literal('too-large'), sentence: text }),
  /** The `ask` route: Ask's own answer, a result with its cited summary and sources, a heavy stop with its token, or a refusal with its cause. */
  z.strictObject({
    status: z.literal('answered'),
    route: z.literal('ask'),
    answer: askAnswerSchema,
    /** Written by the server for a result that was read: what ran and how many elements it lists. Absent for a refusal and for a heavy stop. */
    step: z.strictObject({ intent: z.string().min(1), rows: z.number().int().nonnegative(), outcome: z.enum(['complete', 'partial']) }).optional(),
    /** Written by the server for a result that was read: how much is shown and how much is not yet retrieved, with the quality of the count. */
    coverage: text.optional(),
  }),
  z.strictObject({ status: z.literal('continue-invalid'), sentence: text }),
  /** The view route: sentences that each cite elements read again through the gate and kept by the checks, the citations they name, the model that wrote them and the calls the turn made. */
  z.strictObject({
    status: z.literal('answered'),
    route: z.literal('view'),
    sentences: z.array(summarySentenceSchema).min(1).max(12),
    citations: z.array(z.strictObject({ key: text, kind: z.enum(['entity', 'relationship']), ref: z.union([elementRefSchema, edgeRefSchema]) })).min(1),
    /** The two lines of coverage the server writes: what was read and what is not yet retrieved, and how much of what was read the sentences cite. */
    coverage: z.strictObject({ retrieval: text, summary: text }),
    model: text,
    calls: z.number().int().positive(),
  }),
  /** A message over the limit of words: nothing was sent to a model and nothing was read. */
  z.strictObject({ status: z.literal('too-long'), words: z.number().int().positive(), limit: z.number().int().positive() }),
]);

export type AssistantTurnAnswer = z.infer<typeof assistantTurnAnswerSchema>;
