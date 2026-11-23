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

/** The decisions of a waiting confirmation of a heavy step. */
export const ASSISTANT_CONFIRMATION_DECISIONS = ['confirm', 'skip', 'cancel'] as const;
export type AssistantConfirmationDecision = (typeof ASSISTANT_CONFIRMATION_DECISIONS)[number];

/** The most characters of the plan a confirmation carries: a fixed ceiling, so the plan stays inside the size of a request. */
export const ASSISTANT_PLAN_MAX_CHARACTERS = 24_000;
/** A plan: when it expires, what it holds, and the signature of both with what they are bound to; each part is plain text of its own alphabet. */
export const ASSISTANT_PLAN_PATTERN = /^[0-9]{1,16}\.[A-Za-z0-9_-]{1,23000}\.[0-9a-f]{64}$/;

const planValues = z.record(z.string().min(1).max(64), z.string().min(1).max(400));

/** A step of the turn the plan names: the tool and the values the gate accepted for it, and whether it is a heavy step the analyst confirmed (which a replay reads as its one bounded page without asking again). */
const planStepSchema = z.strictObject({ tool: z.string().min(1).max(200), values: planValues, confirmed: z.literal(true).optional() });

/**
 * What a decision needs to carry the turn on: the hash of the message and of the view's keys it was made for, the earlier steps (read again on a decision, never stored), the step it waits on and the counters of the
 * turn. Tools and values the gate accepted, and counters: no result, no element, no text of the model. The plan is signed by the server and sent back unchanged.
 */
export const assistantPlanSchema = z.strictObject({
  messageHash: z.string().regex(/^[0-9a-f]{64}$/),
  viewHash: z.string().regex(/^[0-9a-f]{64}$/),
  fromView: z.boolean(),
  /** The form of the answer the router chose for the waiting turn: the turn that goes on keeps it. */
  form: z.literal('table').optional(),
  steps: z.array(planStepSchema).max(40),
  wait: planStepSchema,
  counters: z.strictObject({ steps: z.number().int().min(1), rows: z.number().int().nonnegative(), calls: z.number().int().nonnegative(), elapsedMs: z.number().int().nonnegative() }),
  /** The record of the waiting turn, which the turn that goes on from it names. */
  runId: z.uuid().optional(),
});
export type AssistantPlan = z.infer<typeof assistantPlanSchema>;
export type AssistantPlanStep = z.infer<typeof planStepSchema>;

/** What the panel sends to decide a waiting confirmation: its id, the signed plan it was given and the decision, with the message as typed and the keys of the view of the waiting turn (the server compares both with the hashes the plan holds). */
export const assistantConfirmationSchema = z.strictObject({
  pendingId: z.string().uuid(),
  plan: z.string().max(ASSISTANT_PLAN_MAX_CHARACTERS).regex(ASSISTANT_PLAN_PATTERN),
  decision: z.enum(ASSISTANT_CONFIRMATION_DECISIONS),
});

/** A turn is a message, the continue of a heavy stop (the intent, the entities and the token of the answer that stopped), the choice of an element a clarification offered or the decision of a waiting confirmation (with the message and the view of the waiting turn), never two of them: four forms, so the published schema says so. */
export const assistantTurnRequestSchema = z.union([
  z.strictObject({
    ...turnBase,
    message: text,
    /** The token of an AI case summary the person keeps attached to the thread; the server opens it for every turn. */
    summaryToken: text.optional(),
    /** The keys of the elements selected on the canvas, a hint for what "this" and "it" mean; the server keeps only those that are also in `viewElementKeys`. Only a typed message carries it. */
    selectionKeys: z.array(text).max(ASSISTANT_VIEW_KEYS_MAX).optional(),
  }),
  z.strictObject({ ...turnBase, message: text, confirmation: assistantConfirmationSchema }),
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

/** What the Assistant may point the analyst to instead of doing it: the model names one of these in its answer and the server writes the sentence. */
export const ASSISTANT_POINTERS = ['canvas-expand'] as const;
export type AssistantPointer = (typeof ASSISTANT_POINTERS)[number];

export const ASSISTANT_POINTER_SENTENCES: Readonly<Record<AssistantPointer, string>> = {
  'canvas-expand': 'I read neighbours but do not change the canvas. Use Expand on the canvas to add them to the graph.',
};

export const ASSISTANT_NOT_ANSWERED_SENTENCE = 'I can’t support an answer from this investigation.';

export const ASSISTANT_FAILURE_KINDS = ['service', 'source-unavailable', 'busy', 'timeout', 'rate-limit'] as const;
export type AssistantFailureKind = (typeof ASSISTANT_FAILURE_KINDS)[number];

/** The limits that end a turn of the tool loop, and the fixed sentence of each: nothing of the model, the message or the source is in them. */
export const ASSISTANT_LIMITS = ['calls', 'steps', 'rows', 'time', 'input'] as const;
export type AssistantLimit = (typeof ASSISTANT_LIMITS)[number];

export const ASSISTANT_LIMIT_SENTENCES: Readonly<Record<AssistantLimit, string>> = {
  calls: 'This turn reached its limit for model calls, so it stopped. What was read is shown above.',
  steps: 'This turn reached its limit for reads, so it stopped. What was read is shown above.',
  rows: 'This turn reached its limit for rows, so it stopped. What was read is shown above.',
  time: 'This turn ran out of time, so it stopped. What was read is shown above.',
  input: 'This turn grew past what it may send, so it stopped. What was read is shown above.',
};

export const ASSISTANT_TOO_LARGE_SENTENCE = 'The message and the view are too large to send. Narrow the view or ask something smaller.';

export const ASSISTANT_CONTINUE_INVALID_SENTENCE = 'This continue is no longer valid. Nothing was read.';

export const ASSISTANT_CHOICE_INVALID_SENTENCE = 'This choice is no longer valid. Nothing was read.';

export const ASSISTANT_SUMMARY_INVALID_SENTENCE = 'This summary can no longer be used. Generate it again.';
export const ASSISTANT_CONFIRMATION_INVALID_SENTENCE = 'This confirmation is no longer valid. Nothing was read.';

/** The most characters of the title a citation of an answer after tool steps carries: a longer title is cut at a code point, so an element with a long title never fails the answer. */
export const ASSISTANT_CITATION_TITLE_MAX = 400;
/** The most types a question about meaning may name, and the longest name. */
export const ASSISTANT_MEANING_NAMES_MAX = 8;
export const ASSISTANT_MEANING_NAME_MAX = 80;

/** The citation of a meaning line (`m1`): what the mapping says a type means, as the server wrote it into the call. It names no element and no record; `type` is the type's display name, or the relationship type's name. */
const assistantDescriptionCitationSchema = z.strictObject({ key: text, kind: z.literal('description'), typeKind: z.enum(['entity', 'relationship']), type: text.max(ASSISTANT_CITATION_TITLE_MAX), description: text.max(300) });

/** What kind of tool a read was, as the registry names it: an intent of the source's folder, a catalog template, a pattern, the view, or one of the application's own reads: the typology, the person's AI notes and the AI case summary. */
export const ASSISTANT_READ_KINDS = ['intent', 'template', 'pattern', 'view', 'typology', 'ai-notes', 'ai-summary'] as const;
export type AssistantReadKind = (typeof ASSISTANT_READ_KINDS)[number];

/** How sure the number of rows of a read is: the quality of its count. */
export const ASSISTANT_COUNT_QUALITIES = ['exact', 'estimated', 'lowerBound', 'unknown'] as const;

/**
 * One read of a turn, written by the server: the tool and its kind, the subject (the values the gate accepted for the tool's parameters, as Ask's "Understood as" line shows them), and, for a read that ran, the
 * rows it gave with the quality of that count (no number when the count is unknown) and whether it is partial (the typology gives lines instead of rows); a read that did not run says so and has no subject.
 */
export const assistantReadSchema = z.union([
  z
    .strictObject({
      tool: text.max(200),
      /** The plain-words label the operator gave the intent in the Ask folder; none for a template, a pattern or the view, and for an intent without one. */
      label: text.max(80).optional(),
      kind: z.enum(ASSISTANT_READ_KINDS),
      subject: text.max(400).optional(),
      read: z.literal(true),
      rows: z.number().int().nonnegative().optional(),
      quality: z.enum(ASSISTANT_COUNT_QUALITIES),
      partial: z.boolean(),
      /** For the typology: the lines it gave, which are no rows of the source and have no count of rows. */
      lines: z.number().int().nonnegative().optional(),
    })
    .refine((entry) => entry.lines !== undefined || (entry.quality === 'unknown') === (entry.rows === undefined), { message: 'a count that is unknown has no number and every other count has one', path: ['rows'] }),
  z.strictObject({ tool: text.max(200), label: text.max(80).optional(), kind: z.enum(ASSISTANT_READ_KINDS), read: z.literal(false) }),
]);

export type AssistantRead = z.infer<typeof assistantReadSchema>;

/** The bounds of a table answer: columns, rows, the length of a label and of a cell, and the keys a row cites. */
export const ASSISTANT_TABLE_COLUMNS_MAX = 6;
export const ASSISTANT_TABLE_ROWS_MAX = 25;
export const ASSISTANT_TABLE_LABEL_MAX = 40;
export const ASSISTANT_TABLE_CELL_MAX = 80;
export const ASSISTANT_TABLE_CITES_MAX = 6;

/** A table the model drafted, kept row by row by the checks: the title and the counts are the server's, every row cites the elements it reads. `droppedRows` is how many rows the checks removed; `moreNotShown` how many rows the model wrote beyond the row limit. */
export const assistantTableSchema = z
  .strictObject({
    title: text,
    columns: z.array(text.max(ASSISTANT_TABLE_LABEL_MAX)).min(1).max(ASSISTANT_TABLE_COLUMNS_MAX),
    rows: z.array(z.strictObject({ cells: z.array(z.string().max(ASSISTANT_TABLE_CELL_MAX)), cites: z.array(text).min(1).max(ASSISTANT_TABLE_CITES_MAX) })).min(1).max(ASSISTANT_TABLE_ROWS_MAX),
    droppedRows: z.number().int().positive().optional(),
    moreNotShown: z.number().int().positive().optional(),
  })
  .refine((table) => table.rows.every((row) => row.cells.length === table.columns.length), { message: 'a row has a cell for each column', path: ['rows'] });

export type AssistantTable = z.infer<typeof assistantTableSchema>;

/** The most sentences of the overview that may stand beside a verdict refusal. */
export const ASSISTANT_OVERVIEW_SENTENCES_MAX = 12;

/**
 * A neutral overview of the elements in view, drafted and checked as a view answer is: sentences that each cite elements kept by the checks, the citations they name (and no others), the two lines of coverage the server writes, and the model that wrote
 * the sentences. It says what is connected and holds no assessment.
 */
const assistantOverviewSchema = z
  .strictObject({
    sentences: z.array(summarySentenceSchema).min(1).max(ASSISTANT_OVERVIEW_SENTENCES_MAX),
    citations: z.array(z.strictObject({ key: text, kind: z.enum(['entity', 'relationship']), ref: z.union([elementRefSchema, edgeRefSchema]) })).min(1),
    coverage: z.strictObject({ retrieval: text, summary: text }),
    model: text,
  })
  .refine((overview) => overview.sentences.every((sentence) => sentence.cites.length > 0), { message: 'every sentence of an overview cites an element', path: ['sentences'] })
  .refine(
    (overview) => {
      const known = new Set(overview.citations.map((citation) => citation.key));
      const cited = new Set(overview.sentences.flatMap((sentence) => sentence.cites));
      return [...cited].every((key) => known.has(key)) && [...known].every((key) => cited.has(key));
    },
    { message: 'the citations of an overview are exactly the keys its sentences cite', path: ['citations'] },
  );
export type AssistantOverview = z.infer<typeof assistantOverviewSchema>;

export const assistantTurnAnswerSchema = z.union([
  z
    .strictObject({
      status: z.literal('answered'),
      route: z.literal('refuse'),
      cause: z.enum(ASSISTANT_REFUSAL_CAUSES),
      sentence: text,
      /** A refusal of a verdict may carry what the investigation connects, beside its fixed sentence; no other cause carries one. */
      overview: assistantOverviewSchema.optional(),
    })
    .refine((answer) => answer.overview === undefined || (answer.cause === 'verdict' && answer.sentence === ASSISTANT_REFUSAL_SENTENCES.verdict), { message: 'only a verdict refusal carries an overview, and its sentence stays the fixed one', path: ['overview'] }),
  z.strictObject({ status: z.literal('not-answered'), route: z.enum(['ask', 'view']), sentence: text }),
  /**
   * A question that asks only what types or links mean, answered by the server from the operator's text: each type the mapping describes with its description as the operator wrote it, and the fixed sentence for the types it does not. No model wrote any of it.
   */
  z.strictObject({
    status: z.literal('meaning'),
    described: z.array(z.strictObject({ typeKind: z.enum(['entity', 'relationship']), type: text.max(ASSISTANT_CITATION_TITLE_MAX), description: text.max(300) })).max(ASSISTANT_MEANING_NAMES_MAX),
    noDescription: z.strictObject({ sentence: text, names: z.array(text.max(ASSISTANT_CITATION_TITLE_MAX)).min(1).max(ASSISTANT_MEANING_NAMES_MAX) }).optional(),
  }).refine((answer) => answer.described.length > 0 || answer.noDescription !== undefined, { message: 'a meaning answer says something', path: ['described'] }),
  /** A question about what a type means, when the mapping gives the type no description: the fixed sentence the server wrote from the names of the profile, and the names. No element is cited and no model's word is shown. */
  z.strictObject({ status: z.literal('no-description'), route: z.enum(['ask', 'view']), sentence: text, names: z.array(text.max(ASSISTANT_CITATION_TITLE_MAX)).min(1).max(40) }),
  /** A failure of the model's service; `readStarted` is false when no read of the source began, and `retryAfterSeconds` is present only when the service said how long to wait. */
  z.strictObject({ status: z.literal('unavailable'), kind: z.enum(ASSISTANT_FAILURE_KINDS), readStarted: z.boolean(), retryAfterSeconds: z.number().int().positive().optional() }),
  z.strictObject({ status: z.literal('too-large'), sentence: text }),
  /** A turn of the tool loop that reached one of its limits: it ran nothing more, and the sentence is the fixed one of the limit. */
  z.strictObject({ status: z.literal('limit'), limit: z.enum(ASSISTANT_LIMITS), sentence: text, reads: z.array(assistantReadSchema).max(20) }),
  /** The `ask` route: Ask's own answer, a result with its cited summary and sources, a heavy stop with its token, or a refusal with its cause. */
  z.strictObject({
    status: z.literal('answered'),
    route: z.literal('ask'),
    answer: askAnswerSchema,
    /** Written by the server for a result that was read: each read of the turn in order, with its kind, subject, rows and the quality of that count. Absent for a refusal and for a heavy stop, except the refusal of a value that does not fit (`value-not-fit`) that ends a tool loop, which lists the reads the earlier steps made. */
    reads: z.array(assistantReadSchema).min(1).max(20).optional(),
    /** The limit that ended the reading of the turn, when it did: the answer is over what was read, and the panel shows the stop sentence of the limit under it. */
    stoppedAt: z.enum(ASSISTANT_LIMITS).optional(),
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
  /** A decision whose confirmation is unknown, used, expired, replaced, another person's, another investigation's, source's or masking's, whose plan is altered or whose message or view is not the one it was made for: nothing was read. */
  z.strictObject({ status: z.literal('confirmation-invalid'), sentence: text }),
  /** The decision to cancel a waiting confirmation: the pending state is dropped and nothing was read. */
  z.strictObject({ status: z.literal('cancelled') }),
  /**
   * A heavy step of the loop waits for the analyst: the pending id and the signed plan the decision sends back, what the step would read (its tool and kind, the subject, the count with its quality, the size of the page) and the reads made so far. Nothing of the step was read.
   */
  z.strictObject({
    status: z.literal('confirmation'),
    pendingId: z.string().uuid(),
    plan: z.string().max(ASSISTANT_PLAN_MAX_CHARACTERS).regex(ASSISTANT_PLAN_PATTERN),
    step: z.strictObject({
      tool: text.max(200),
      label: text.max(80).optional(),
      kind: z.enum(ASSISTANT_READ_KINDS),
      subject: text.max(400).optional(),
      count: z.strictObject({ quality: z.enum(ASSISTANT_COUNT_QUALITIES), value: z.number().int().nonnegative().optional() }),
      page: z.number().int().positive(),
    }),
    reads: z.array(assistantReadSchema).max(20),
  }),
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
    citations: z.array(z.union([z.strictObject({ key: text, kind: z.enum(['entity', 'relationship']), ref: z.union([elementRefSchema, edgeRefSchema]) }), assistantDescriptionCitationSchema])).min(1),
    /** The two lines of coverage the server writes: what was read and what is not yet retrieved, and how much of what was read the sentences cite. */
    coverage: z.strictObject({ retrieval: text, summary: text, /** Written by the server when the answer rests on sentences of an attached summary: which of them, in words. */ summaryCited: text.optional() }),
    /** The positions (from 1, as the summary's sentences are numbered in the draft) of the attached summary's sentences the answer cites; present only when there are some. */
    summarySentencesCited: z.array(z.number().int().min(1).max(12)).min(1).max(12).optional(),
    /** The fixed sentence for a type in the question that the mapping does not describe, beside the sentences for the ones it does. */
    noDescription: text.optional(),
    /** The fixed sentence of a pointer the model asked for in its `answer` (see `ASSISTANT_POINTER_SENTENCES`): written by the server, never by the model. */
    pointer: text.optional(),
    model: text,
    calls: z.number().int().positive(),
  }),
  /** The `ask` or the `view` route (the route the message was placed on) after tool steps: sentences that each cite elements the steps returned, or the line of a read (to state what it found, including nothing), kept by the checks, the citations of elements they name (none when every sentence cites reads only), the model that wrote them, the calls the turn made and the steps it ran. */
  z.strictObject({
    status: z.literal('answered'),
    route: z.enum(['ask', 'view']),
    sentences: z.array(summarySentenceSchema).min(1).max(12),
    /** `title` is the element's title as the result gave it (masked as it was asked), so an element that is not drawn is still named. */
    citations: z.array(z.union([z.strictObject({ key: text, kind: z.enum(['entity', 'relationship']), ref: z.union([elementRefSchema, edgeRefSchema]), title: text.max(ASSISTANT_CITATION_TITLE_MAX).optional() }), assistantDescriptionCitationSchema])).min(0),
    coverage: z.strictObject({ retrieval: text, summary: text }),
    /** As for the view route's answer. */
    noDescription: text.optional(),
    /** The fixed sentence of a pointer the model asked for in its `answer` (see `ASSISTANT_POINTER_SENTENCES`): written by the server, never by the model. */
    pointer: text.optional(),
    model: text,
    calls: z.number().int().positive(),
    steps: z.number().int().min(1),
    /** Each read of the turn in order, written by the server. */
    reads: z.array(assistantReadSchema).min(1).max(20),
    /** The limit that ended the reading of the turn, when it did. */
    stoppedAt: z.enum(ASSISTANT_LIMITS).optional(),
    /** For the `ask` route, when the answer rests on a read of one of the folder's questions: the same follow-ups as Ask's own answer to that read. */
    followUps: z.array(z.strictObject({ titles: z.array(text).min(1).max(20), choice: assistantChoiceSchema })).max(ASSISTANT_FOLLOW_UPS_MAX).optional(),
  }),
  /** The view route, asked for as a table: the rows that the checks kept, each citing the elements it reads, the citations they name, the coverage the server writes, the model and the calls. */
  z.strictObject({
    status: z.literal('answered'),
    route: z.literal('view'),
    table: assistantTableSchema,
    citations: z.array(z.union([z.strictObject({ key: text, kind: z.enum(['entity', 'relationship']), ref: z.union([elementRefSchema, edgeRefSchema]) }), assistantDescriptionCitationSchema])).min(1),
    coverage: z.strictObject({ retrieval: text, summary: text }),
    /** The fixed sentence for a type in the question that the mapping does not describe, beside the table. */
    noDescription: text.optional(),
    /** The fixed sentence of a pointer the model asked for in its `answer` (see `ASSISTANT_POINTER_SENTENCES`): written by the server, never by the model. */
    pointer: text.optional(),
    model: text,
    calls: z.number().int().positive(),
  }),
  /** The view route, asked for as a table, after tool steps: the table over the elements of the reads, with the steps and the reads of the turn. */
  z.strictObject({
    status: z.literal('answered'),
    route: z.literal('view'),
    table: assistantTableSchema,
    citations: z.array(z.union([z.strictObject({ key: text, kind: z.enum(['entity', 'relationship']), ref: z.union([elementRefSchema, edgeRefSchema]), title: text.max(ASSISTANT_CITATION_TITLE_MAX).optional() }), assistantDescriptionCitationSchema])).min(1),
    coverage: z.strictObject({ retrieval: text, summary: text }),
    noDescription: text.optional(),
    /** The fixed sentence of a pointer the model asked for in its `answer` (see `ASSISTANT_POINTER_SENTENCES`): written by the server, never by the model. */
    pointer: text.optional(),
    model: text,
    calls: z.number().int().positive(),
    steps: z.number().int().min(1),
    reads: z.array(assistantReadSchema).min(1).max(20),
    stoppedAt: z.enum(ASSISTANT_LIMITS).optional(),
  }),
  /** A message over the limit of words: nothing was sent to a model and nothing was read. */
  z.strictObject({ status: z.literal('too-long'), words: z.number().int().positive(), limit: z.number().int().positive() }),
]);

export type AssistantTurnAnswer = z.infer<typeof assistantTurnAnswerSchema>;
export type AssistantDescriptionCitation = z.infer<typeof assistantDescriptionCitationSchema>;

/** The longest a streamed turn stays open: the highest total time of a turn the settings accept (10 minutes) and a minute more. */
export const ASSISTANT_STREAM_MAX_MS = 660_000;

/** The phases of a turn a client is told about, in the order a turn goes through them. */
export const ASSISTANT_STEP_PHASES = ['routing', 'reading-view', 'reading', 'read-done', 'answering'] as const;

/**
 * The members of a `step` event: which step of the turn is about to run. `tool`, `label` and `subject` belong to a read: the tool's name (the intent's name or the template's), the plain-words label the operator gave an intent (when it has one),
 * and the values the registry's parameter check accepted for it, as the confirmation card shows them; `read-done` follows each read with its record (rows, the quality of the count, partial). Nothing a model wrote is in a step.
 */
export const assistantStepMembersSchema = z
  .strictObject({
    n: z.number().int().min(1).max(60),
    phase: z.enum(ASSISTANT_STEP_PHASES),
    tool: text.max(200).optional(),
    label: text.max(80).optional(),
    subject: text.max(400).optional(),
    /** The kind of the tool of a read that is starting, for its tag. */
    kind: z.enum(ASSISTANT_READ_KINDS).optional(),
    /** The read that has just finished, exactly as the answer will list it in its steps. */
    read: assistantReadSchema.optional(),
  })
  .refine((step) => step.phase === 'reading' || (step.tool === undefined && step.label === undefined && step.subject === undefined && step.kind === undefined), { message: 'only a read that is starting names its tool, label, subject and kind', path: ['phase'] })
  .refine((step) => (step.phase === 'read-done') === (step.read !== undefined), { message: 'only a finished read carries its record, and it always does', path: ['read'] });

/** One line of a streamed turn. The first lines are steps, the last is the answer exactly as the JSON route gives it, or an error that has no turn answer. */
export const assistantTurnStreamEventSchema = z.union([
  assistantStepMembersSchema.safeExtend({ event: z.literal('step') }),
  z.strictObject({ event: z.literal('answer'), answer: z.lazy(() => assistantTurnAnswerSchema) }),
  z.object({ event: z.literal('error'), code: z.string().min(1), message: z.string(), retryable: z.boolean().optional(), traceId: z.string().min(1), details: z.record(z.string(), z.unknown()).optional() }),
]);
/** @public The type of a line of a streamed turn, for the clients that read one. */
export type AssistantTurnStreamEvent = z.infer<typeof assistantTurnStreamEventSchema>;
