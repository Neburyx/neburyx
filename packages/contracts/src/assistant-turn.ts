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

/** What a clarification or a follow-up gives the panel to send when it is chosen: the intent, the roles whose value is an element (each read again through the gate), the entities, and the token that binds them to this person and investigation. */
export const assistantChoiceSchema = z.strictObject({
  intent: askContinueRequestSchema.shape.intent,
  roles: z.array(z.string().min(1).max(64)).min(1).max(20),
  entities: askContinueRequestSchema.shape.entities,
  choiceToken: askContinueRequestSchema.shape.continueToken,
});

export type AssistantChoice = z.infer<typeof assistantChoiceSchema>;

/** A turn is a message, the continue of a heavy stop (the intent, the entities and the token of the answer that stopped) or the choice of an element a clarification offered, never two of them: three forms, so the published schema says so. */
export const assistantTurnRequestSchema = z.union([
  z.strictObject({ ...turnBase, message: text, /** The token of an AI case summary the person keeps attached to the thread; the server opens it for every turn. */ summaryToken: text.optional() }),
  z.strictObject({ ...turnBase, continue: askContinueRequestSchema.pick({ intent: true, entities: true, continueToken: true }) }),
  z.strictObject({ ...turnBase, choice: assistantChoiceSchema }),
]);

export type AssistantTurnRequest = z.infer<typeof assistantTurnRequestSchema>;

/** Why the router refused a message; the sentence is chosen by the server from the cause, never by the model. */
export const ASSISTANT_REFUSAL_CAUSES = ['verdict', 'raw-query', 'other-source', 'unplaced'] as const;
export type AssistantRefusalCause = (typeof ASSISTANT_REFUSAL_CAUSES)[number];

export const ASSISTANT_REFUSAL_SENTENCES: Readonly<Record<AssistantRefusalCause, string>> = {
  verdict: 'I can’t judge guilt or intent. I can show what the investigation connects.',
  'raw-query': 'I can’t take query text. Describe what you want to see in plain words.',
  'other-source': 'I can only work with the source of this investigation.',
  unplaced: 'I can’t place this message. Rephrase it, or use the manual tools.',
};

/** The most follow-ups an answer suggests. */
export const ASSISTANT_FOLLOW_UPS_MAX = 3;

/** The most elements a clarification offers to choose from. */
export const ASSISTANT_CLARIFICATION_MAX_CANDIDATES = 5;

/** The question of a clarification, naming the entity type as the profile calls it. */
export const assistantClarificationQuestion = (typeName: string): string => `Which ${/^[A-Z][a-z]/.test(typeName) ? typeName.charAt(0).toLowerCase() + typeName.slice(1) : typeName} do you mean?`;

export const ASSISTANT_NOT_ANSWERED_SENTENCE = 'I can’t support an answer from this investigation.';

export const ASSISTANT_FAILURE_KINDS = ['service', 'source-unavailable', 'busy', 'timeout', 'rate-limit'] as const;
export type AssistantFailureKind = (typeof ASSISTANT_FAILURE_KINDS)[number];

/** The limits that end a turn of the tool loop, and the fixed sentence of each: nothing of the model, the message or the source is in them. */
export const ASSISTANT_LIMITS = ['calls', 'steps', 'rows', 'time', 'input'] as const;
export type AssistantLimit = (typeof ASSISTANT_LIMITS)[number];

export const ASSISTANT_LIMIT_SENTENCES: Readonly<Record<AssistantLimit, string>> = {
  calls: 'The assistant reached the number of model calls a turn may make, so it stopped. Nothing more was read.',
  steps: 'The assistant reached the number of reads a turn may make, so it stopped. Nothing more was read.',
  rows: 'The assistant reached the number of rows a turn may read, so it stopped. Nothing more was read.',
  time: 'The assistant reached the time a turn may take, so it stopped. Nothing more was read.',
  input: 'What the assistant had to send grew past what a turn may send, so it stopped. Nothing more was read.',
};

export const ASSISTANT_TOO_LARGE_SENTENCE = 'The message and the view are too large to send. Narrow the view or ask something smaller.';

export const ASSISTANT_CONTINUE_INVALID_SENTENCE = 'This continue is no longer valid. Nothing was read.';

export const ASSISTANT_CHOICE_INVALID_SENTENCE = 'This choice is no longer valid. Nothing was read.';

export const ASSISTANT_SUMMARY_INVALID_SENTENCE = 'This summary can no longer be used. Generate it again.';

export const assistantTurnAnswerSchema = z.union([
  z.strictObject({
    status: z.literal('answered'),
    route: z.literal('refuse'),
    cause: z.enum(ASSISTANT_REFUSAL_CAUSES),
    sentence: text,
  }),
  z.strictObject({ status: z.literal('not-answered'), route: z.enum(['ask', 'view']), sentence: text }),
  /** A failure of the model's service; `readStarted` is false when no read of the source began, and `retryAfterSeconds` is present only when the service said how long to wait. */
  z.strictObject({ status: z.literal('unavailable'), kind: z.enum(ASSISTANT_FAILURE_KINDS), readStarted: z.boolean(), retryAfterSeconds: z.number().int().positive().optional() }),
  z.strictObject({ status: z.literal('too-large'), sentence: text }),
  /** A turn of the tool loop that reached one of its limits: it ran nothing more, and the sentence is the fixed one of the limit. */
  z.strictObject({ status: z.literal('limit'), limit: z.enum(ASSISTANT_LIMITS), sentence: text }),
  /** The `ask` route: Ask's own answer, a result with its cited summary and sources, a heavy stop with its token, or a refusal with its cause. */
  z.strictObject({
    status: z.literal('answered'),
    route: z.literal('ask'),
    answer: askAnswerSchema,
    /** Written by the server for a result that was read: what ran and how many elements it lists. Absent for a refusal and for a heavy stop. */
    step: z.strictObject({ intent: z.string().min(1), rows: z.number().int().nonnegative(), outcome: z.enum(['complete', 'partial']) }).optional(),
    /** Written by the server for a result that was read: how much is shown and how much is not yet retrieved, with the quality of the count. */
    coverage: text.optional(),
    /** Other template questions of the source's folder the answer's elements can be put to, each with the titles of the elements as the analyst sees them and what the panel sends to ask it. */
    followUps: z.array(z.strictObject({ titles: z.array(text).min(1).max(20), choice: assistantChoiceSchema })).max(ASSISTANT_FOLLOW_UPS_MAX).optional(),
  }),
  z.strictObject({ status: z.literal('continue-invalid'), sentence: text }),
  /** A choice whose token is altered, old, another person's, another investigation's or another masking's, whose intent changed, or whose element is no longer readable: nothing was read. */
  z.strictObject({ status: z.literal('choice-invalid'), sentence: text }),
  /** A message that carried a summary that can no longer be used, whatever the cause: no answer was built from it. */
  z.strictObject({ status: z.literal('summary-invalid'), sentence: text }),
  /** A message the assistant cannot place on one element: the fixed question naming the entity type, and each element it may mean as the analyst sees it, with what the panel sends when it is picked. Nothing was read for the intent. */
  z.strictObject({
    status: z.literal('clarification'),
    question: text,
    candidates: z.array(z.strictObject({ title: text, type: text, choice: assistantChoiceSchema })).min(1).max(ASSISTANT_CLARIFICATION_MAX_CANDIDATES),
  }),
  /** The view route: sentences that each cite elements read again through the gate and kept by the checks, the citations they name, the model that wrote them and the calls the turn made. */
  z.strictObject({
    status: z.literal('answered'),
    route: z.literal('view'),
    sentences: z.array(summarySentenceSchema).min(1).max(12),
    citations: z.array(z.strictObject({ key: text, kind: z.enum(['entity', 'relationship']), ref: z.union([elementRefSchema, edgeRefSchema]) })).min(1),
    /** The two lines of coverage the server writes: what was read and what is not yet retrieved, and how much of what was read the sentences cite. */
    coverage: z.strictObject({ retrieval: text, summary: text, /** Written by the server when the answer rests on sentences of an attached summary: which of them, in words. */ summaryCited: text.optional() }),
    /** The positions (from 1, as the summary's sentences are numbered in the draft) of the attached summary's sentences the answer cites; present only when there are some. */
    summarySentencesCited: z.array(z.number().int().min(1).max(12)).min(1).max(12).optional(),
    model: text,
    calls: z.number().int().positive(),
  }),
  /** The `ask` or the `view` route (the route the message was placed on) after tool steps: sentences that each cite elements the steps returned, or the line of a read (to state what it found, including nothing), kept by the checks, the citations of elements they name (none when every sentence cites reads only), the model that wrote them, the calls the turn made and the steps it ran. */
  z.strictObject({
    status: z.literal('answered'),
    route: z.enum(['ask', 'view']),
    sentences: z.array(summarySentenceSchema).min(1).max(12),
    citations: z.array(z.strictObject({ key: text, kind: z.enum(['entity', 'relationship']), ref: z.union([elementRefSchema, edgeRefSchema]) })).min(0),
    coverage: z.strictObject({ retrieval: text, summary: text }),
    model: text,
    calls: z.number().int().positive(),
    steps: z.number().int().min(2),
  }),
  /** A message over the limit of words: nothing was sent to a model and nothing was read. */
  z.strictObject({ status: z.literal('too-long'), words: z.number().int().positive(), limit: z.number().int().positive() }),
]);

export type AssistantTurnAnswer = z.infer<typeof assistantTurnAnswerSchema>;
