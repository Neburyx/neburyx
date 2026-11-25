import { z } from 'zod';
import { ASK_FOLDER_LIMITS, isParameterName } from './ask-folder.js';
import { ASK_SUMMARY_MAX_CITATIONS, ASK_TEMPLATE_IDS, SAVED_PATTERN_TEMPLATE_ID } from './ask.js';
import { assistantTableUnitSchema, ASSISTANT_CITATION_TITLE_MAX, ASSISTANT_LIST_ITEMS_MAX, ASSISTANT_LIST_LABEL_MAX, ASSISTANT_OVERVIEW_SENTENCES_MAX, ASSISTANT_TABLE_CELL_MAX, ASSISTANT_TABLE_COLUMNS_MAX, ASSISTANT_TABLE_LABEL_MAX, ASSISTANT_TABLE_ROWS_MAX, ASSISTANT_VIEW_KEYS_MAX } from './assistant-turn.js';
import { readAskResultSchema, storedAskResultSchema } from './ask-result-stored.js';
import { edgeRefSchema, elementRefSchema } from './graph.js';
import { DEFAULT_INVESTIGATION_LIST_LIMIT, MAX_INVESTIGATION_LIST_LIMIT, MAX_LIST_TEXT_LENGTH, chatInvestigationSchema, listFilterTextSchema } from './investigations.js';

const wholeCount = z.number().int().nonnegative();
const label = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:/-]+$/);
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

/** The routes and ends of a turn that a thread keeps: a turn that failed, was cancelled or was not let through leaves nothing. */
export const THREAD_TURN_ROUTES = ['ask', 'view', 'refuse'] as const;
export const THREAD_TURN_OUTCOMES = ['answered', 'refused', 'waiting'] as const;

/** The element a parameter of an intent resolved to, with the role (the parameter's name) it had; never the text the person typed. */
export const threadEntitySchema = z.strictObject({ role: z.string().refine(isParameterName, { message: 'a parameter name' }), ref: elementRefSchema });

/** A thing a turn cited: an element or a relationship, as a summary cites it. */
export const threadCitationRefSchema = z.union([elementRefSchema, edgeRefSchema]);

/**
 * The most characters of the question a thread keeps (the person's own typed text, as typed) and of one sentence of a stored answer. Decided with the stored form: the contract bounded neither, and a turn whose text is longer is not stored (the answer
 * the person receives is unchanged). A cell and a label keep the bounds of the table.
 */
export const THREAD_QUESTION_MAX = 4000;
export const THREAD_SENTENCE_MAX = 2000;
/** The most blocks one stored answer holds. */
export const THREAD_ANSWER_BLOCKS_MAX = 8;

/** The most segments (pieces of literal text and bindings together) one stored item holds; an item that needs more is stored `unbound`. */
export const THREAD_SEGMENTS_MAX = 40;

/**
 * The forms an item of a stored answer is kept in. `frozen`: the text as written, which holds no sensitive value of any element sent to the model (every item of a turn written with the mask on). `unbound`: the text as written, whole, because it
 * may hold a sensitive value; it is never returned while the mask is on. `bound`: segments, literal text and, in place of each sensitive value, the element and the property it is the whole value of; no value is stored.
 */
export const THREAD_ITEM_FORMS = ['frozen', 'unbound', 'bound'] as const;

const textItem = (max: number, min = 1) => z.strictObject({ form: z.enum(['frozen', 'unbound']), text: z.string().min(min).max(max) });
const segmentSchema = z.union([z.strictObject({ literal: z.string().min(1).max(THREAD_SENTENCE_MAX) }), z.strictObject({ element: threadCitationRefSchema, property: z.string().min(1).max(200) })]);
const boundItem = z.strictObject({ form: z.literal('bound'), segments: z.array(segmentSchema).min(1).max(THREAD_SEGMENTS_MAX) });
const storedCites = z.array(threadCitationRefSchema).max(Math.max(ASK_SUMMARY_MAX_CITATIONS, ASSISTANT_VIEW_KEYS_MAX));

type Binding = { readonly element: unknown; readonly property: string };
const bindingsOf = (item: { readonly form: string; readonly segments?: readonly unknown[] }): Binding[] => (item.form === 'bound' ? (item.segments ?? []).filter((segment): segment is Binding => typeof segment === 'object' && segment !== null && 'element' in segment) : []);
/** Every binding of an item names an element the item cites, and a bound item holds at least one binding: a value is bound to the element it is cited with. */
const bindsItsCites = (item: { readonly form: string; readonly segments?: readonly unknown[]; readonly cites: readonly unknown[] }): boolean => {
  const cited = new Set(item.cites.map((cite) => JSON.stringify(cite)));
  const bindings = bindingsOf(item);
  return item.form !== 'bound' || (bindings.length > 0 && bindings.every((binding) => cited.has(JSON.stringify(binding.element))));
};

/** An item of a stored answer: its text in one form, or its segments. A table cell may be empty (a property with no value); a sentence and a label may not. */
const storedCell = (max: number) => z.union([textItem(max, 0), boundItem]);
/** A sentence of a stored answer: its text or its segments, and the references of the elements it cites; a binding is to an element it cites. */
const storedSentence = z.union([textItem(THREAD_SENTENCE_MAX).extend({ cites: storedCites }), boundItem.extend({ cites: storedCites })]).refine(bindsItsCites, { message: 'a binding is to an element the sentence cites' });

/**
 * The stored form of an answer: its ordered blocks. A block is sentences, a table (its title is the server's own fixed text and is not kept; the columns are labels, each cell is an item) or a refusal (its fixed sentence and the overview a verdict
 * refusal may carry). No citation title or snapshot, no follow-up token, no plan and no run id: nothing that is not text of the answer or a reference.
 */
/** What an answer shows of how it was made, as the server wrote it: the model and the two lines of coverage (the counts with their labels, exact, estimated, lower bound or unknown) and, when a summary was cited, the line that says so. Counts and type names only, never a value. */
const storedModel = z.string().min(1).max(200);
const storedCoverage = z.strictObject({ retrieval: z.string().min(1).max(2000), summary: z.string().min(1).max(1000), summaryCited: z.string().min(1).max(1000).optional() });

export const storedAnswerSchema = z.strictObject({
  model: storedModel.optional(),
  coverage: storedCoverage.optional(),
  blocks: z
    .array(
      z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('sentences'), items: z.array(storedSentence).min(1).max(12) }),
        z.strictObject({ kind: z.literal('list'), label: textItem(ASSISTANT_LIST_LABEL_MAX).optional(), items: z.array(storedSentence).min(1).max(ASSISTANT_LIST_ITEMS_MAX) }),
        storedAskResultSchema,
        z
          .strictObject({
            kind: z.literal('table'),
            /** What the title and the note of the table say, kept as references and numbers: the entity type of the rows (a key of the mapping), the title of the element the rows were listed from (an item, so that it is kept, or withheld under the mask, as every title is), and the properties whose unit the note gives. The words are written again from the current mapping. A table stored before these were kept has none. */
            caption: z.strictObject({ subject: z.string().min(1).max(200).optional(), anchor: textItem(ASSISTANT_CITATION_TITLE_MAX).optional() }).optional(),
            units: z.array(assistantTableUnitSchema).max(ASSISTANT_TABLE_COLUMNS_MAX).optional(),
            /** How many rows the checks removed and how many the model wrote beyond the limit: numbers, so that a reopened table does not say more than it holds. */
            droppedRows: z.number().int().positive().optional(),
            moreNotShown: z.number().int().positive().optional(),
            columns: z.array(textItem(ASSISTANT_TABLE_LABEL_MAX)).min(1).max(ASSISTANT_TABLE_COLUMNS_MAX),
            rows: z.array(z.strictObject({ cells: z.array(storedCell(ASSISTANT_TABLE_CELL_MAX)).max(ASSISTANT_TABLE_COLUMNS_MAX), cites: storedCites }).refine((row) => row.cells.every((cell) => bindsItsCites({ ...cell, cites: row.cites })), { message: 'a binding is to an element the row cites' })).min(1).max(ASSISTANT_TABLE_ROWS_MAX),
          })
          .refine((table) => table.rows.every((row) => row.cells.length === table.columns.length), { message: 'a row has a cell for each column', path: ['rows'] }),
        z.strictObject({ kind: z.literal('refusal'), sentence: textItem(THREAD_SENTENCE_MAX), overview: z.array(storedSentence).min(1).max(ASSISTANT_OVERVIEW_SENTENCES_MAX).optional() }),
      ]),
    )
    .min(1)
    .max(THREAD_ANSWER_BLOCKS_MAX),
});
export type StoredAnswer = z.infer<typeof storedAnswerSchema>;

/**
 * What a turn leaves in its thread: references and metadata, written through this strict schema so that no text can ride in a permitted member. The bounds are the producers': an intent has at most `ASK_FOLDER_LIMITS.parameters`
 * parameters, an Ask summary cites at most `ASK_SUMMARY_MAX_CITATIONS` things and a view answer at most as many as the view has keys.
 */
export const assistantThreadTurnWriteSchema = z
  .strictObject({
    id: z.uuid(),
    investigationId: z.uuid(),
    userId: z.uuid(),
    at: z.date(),
    route: z.enum(THREAD_TURN_ROUTES),
    outcome: z.enum(THREAD_TURN_OUTCOMES),
    cause: label.optional(),
    questionHash: sha256Hex,
    intent: label.optional(),
    templateId: z.enum([...ASK_TEMPLATE_IDS, SAVED_PATTERN_TEMPLATE_ID]).optional(),
    entities: z.array(threadEntitySchema).max(ASK_FOLDER_LIMITS.parameters),
    citationRefs: z.array(threadCitationRefSchema).max(Math.max(ASK_SUMMARY_MAX_CITATIONS, ASSISTANT_VIEW_KEYS_MAX)),
    steps: wholeCount,
    modelRef: label.optional(),
    promptVersion: label.optional(),
    tokensIn: wholeCount.optional(),
    tokensOut: wholeCount.optional(),
    runId: z.uuid().optional(),
    /** The question as typed, for a turn that carried one; the answer in its stored form; whether the request asked for the mask; and the version of the sensitivity of the mapping the items were classified under (unknown until the values are classified). Present only for an answered or refused turn. */
    question: z.string().min(1).max(THREAD_QUESTION_MAX).optional(),
    maskOn: z.boolean().optional(),
    answer: storedAnswerSchema.optional(),
    sensitivityVersion: label.optional(),
  })
  .refine((turn) => (turn.answer === undefined && turn.question === undefined) || turn.outcome === 'answered' || turn.outcome === 'refused', { message: 'only an answered or a refused turn keeps its text', path: ['answer'] })
  .refine((turn) => (turn.answer === undefined && turn.question === undefined) || turn.maskOn !== undefined, { message: 'text is kept with the state of the mask it was written under', path: ['maskOn'] })
  .refine((turn) => turn.route === 'view' || turn.citationRefs.length <= ASK_SUMMARY_MAX_CITATIONS, { message: 'an Ask answer cites at most as many things as a summary holds', path: ['citationRefs'] });

export type AssistantThreadTurnWrite = z.infer<typeof assistantThreadTurnWriteSchema>;

/**
 * An item of a stored answer as a read gives it: its text, its segments (literal text and, in place of each sensitive value, the element and the property it is the value of: the value is never sent, the panel draws it from the element read
 * again under the current mask), or nothing but a marker that it is withheld.
 */
const readText = z.strictObject({ state: z.literal('text'), text: z.string().max(THREAD_SENTENCE_MAX) });
const readSegments = z.strictObject({ state: z.literal('segments'), segments: z.array(segmentSchema).min(1).max(THREAD_SEGMENTS_MAX) });
const readWithheld = z.strictObject({ state: z.literal('withheld') });
const readItem = z.union([readText, readSegments, readWithheld]);
const readCited = z.array(threadCitationRefSchema).max(Math.max(ASK_SUMMARY_MAX_CITATIONS, ASSISTANT_VIEW_KEYS_MAX));
/** The answer of a turn as a read gives it, block by block, each item in one of the three states. */
export const readAnswerSchema = z.strictObject({
  model: storedModel.optional(),
  coverage: storedCoverage.optional(),
  blocks: z
    .array(
      z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('sentences'), items: z.array(z.object({ item: readItem, cites: readCited }).strict()).min(1).max(12) }),
        readAskResultSchema,
        z.strictObject({ kind: z.literal('list'), label: z.union([readText, readWithheld]).optional(), items: z.array(z.object({ item: readItem, cites: readCited }).strict()).min(1).max(ASSISTANT_LIST_ITEMS_MAX) }),
        z.strictObject({ kind: z.literal('table'), caption: z.strictObject({ subject: z.string().min(1).max(200).optional(), anchor: z.union([readText, readWithheld]).optional() }).optional(), units: z.array(assistantTableUnitSchema).max(ASSISTANT_TABLE_COLUMNS_MAX).optional(), droppedRows: z.number().int().positive().optional(), moreNotShown: z.number().int().positive().optional(), columns: z.array(z.union([readText, readWithheld])).min(1).max(ASSISTANT_TABLE_COLUMNS_MAX), rows: z.array(z.strictObject({ cells: z.array(readItem).max(ASSISTANT_TABLE_COLUMNS_MAX), cites: readCited })).min(1).max(ASSISTANT_TABLE_ROWS_MAX) }),
        z.strictObject({ kind: z.literal('refusal'), sentence: z.union([readText, readWithheld]), overview: z.array(z.object({ item: readItem, cites: readCited }).strict()).min(1).max(ASSISTANT_OVERVIEW_SENTENCES_MAX).optional() }),
      ]),
    )
    .min(1)
    .max(THREAD_ANSWER_BLOCKS_MAX),
});
export type ReadAnswer = z.infer<typeof readAnswerSchema>;

/** One stored turn as the panel is told of it: what kind of turn it was and how it ended, never a hash, a reference, a token or a run id. */
export const assistantThreadTurnSchema = z.strictObject({
  /** The id of the turn: the one its request carried when the panel gave one, else the server's. */
  id: z.uuid(),
  seq: z.number().int().min(1),
  at: z.iso.datetime(),
  route: z.enum(THREAD_TURN_ROUTES),
  outcome: z.enum(THREAD_TURN_OUTCOMES),
  cause: label.optional(),
  intent: label.optional(),
  citedElements: wholeCount,
  steps: wholeCount,
  /** The question as the person typed it, for a turn that kept one; and the answer, item by item, in the state the mask and the sensitivity version allow. A turn stored before text was kept has neither. */
  question: z.string().max(THREAD_QUESTION_MAX).optional(),
  answer: readAnswerSchema.optional(),
});

/** How many of the most recent turns of a thread one read gives, and the most a setting may raise it to. Working limits, not taken from a source, to be measured with the other provisional settings; they bound the answer and what the panel draws and trim nothing that is stored. */
export const THREAD_READ_TURNS_DEFAULT = 100;
export const THREAD_READ_TURNS_CEILING = 500;

/**
 * `GET /v1/assistant/investigations/{id}/thread`: the caller's own thread (its most recent turns, at most `THREAD_READ_TURNS_CEILING`, and how many older ones there are), and when the caller's previous thread was cleared (the investigation was closed),
 * if it was and no thread has been started since.
 */
export const assistantThreadResponseSchema = z.strictObject({ turns: z.array(assistantThreadTurnSchema).max(THREAD_READ_TURNS_CEILING), earlierTurns: wholeCount, previousThreadClearedAt: z.iso.datetime().nullable(), /** The count a turn of this person reads before it starts: it rises when the person clears their thread and when the investigation is closed, so a window can tell that its turns are from before. */ epoch: wholeCount.optional() });

/** `POST /v1/assistant/investigations/{id}/thread/clear`: no member in the body; the answer says whether a thread of the caller was deleted (false: they had none), and holds nothing else. */
export const assistantThreadClearRequestSchema = z.strictObject({});
export const assistantThreadClearResponseSchema = z.strictObject({ cleared: z.boolean() });
export type AssistantThreadClearResponse = z.infer<typeof assistantThreadClearResponseSchema>;

/** What the store gives a read of the thread: the turns with their stored text, before the mask and the version decide what is sent. */
export type StoredTurnText = { readonly question?: string; readonly maskOn?: boolean; readonly answer?: StoredAnswer; readonly sensitivityVersion?: string };

export type AssistantThreadResponse = z.infer<typeof assistantThreadResponseSchema>;

/** Sent with the INTERNAL_ERROR of a clearing whose commit failed or was cut off: the thread may or may not have been deleted. Without it, an error of the clearing says the transaction was rolled back and nothing was deleted. */
export const ASSISTANT_CLEAR_OUTCOME_HEADER = 'x-assistant-clear-outcome';
export const ASSISTANT_CLEAR_OUTCOME_UNKNOWN = 'unknown';

/** The most thread rows one request of the chat list reads, whatever the page: a page that reaches it before it is full is returned short with a cursor. */
export const CHAT_LIST_SCAN_CAP = 1000;

/** The most characters of the last question a row of the chat list carries (counted in code points), the text bound of the investigations list. */
export const CHAT_LAST_QUESTION_MAX = MAX_LIST_TEXT_LENGTH;

/** `limit` is checked against its bounds by the route, since one above the maximum is a budget error and not a malformed request. */
export const assistantThreadListQuerySchema = z.strictObject({
  limit: z
    .string()
    .regex(/^[0-9]{1,18}$/)
    .transform(Number)
    .optional(),
  cursor: z.string().min(1).max(2048).optional(),
  q: listFilterTextSchema.optional(),
});

export const assistantThreadListItemSchema = chatInvestigationSchema.omit({ id: true }).extend({
  investigationId: chatInvestigationSchema.shape.id,
  /** When the last turn of the thread was stored (the date of the last question). */
  lastQuestionAt: z.iso.datetime(),
  /** How many turns the thread holds; 0 for a thread that has none yet. */
  turns: wholeCount,
  /** The newest stored question of the thread, cut to at most its first `CHAT_LAST_QUESTION_MAX` code points at the last whole word (at the code point itself when it has no space); null when no turn has one. */
  lastQuestion: z
    .string()
    .refine((value) => [...value].length <= CHAT_LAST_QUESTION_MAX, { message: 'at most 200 code points' })
    .nullable(),
  /** True when the stored question was longer than `lastQuestion`, which then ends at the word where it was cut: a client shows an ellipsis after it. */
  lastQuestionCut: z.boolean(),
});

export const assistantThreadListResponseSchema = z.strictObject({ items: z.array(assistantThreadListItemSchema).max(MAX_INVESTIGATION_LIST_LIMIT), nextCursor: z.string().min(1).max(2048).nullable() });
export type AssistantThreadListResponse = z.infer<typeof assistantThreadListResponseSchema>;
export { DEFAULT_INVESTIGATION_LIST_LIMIT as CHAT_LIST_DEFAULT_LIMIT, MAX_INVESTIGATION_LIST_LIMIT as CHAT_LIST_MAX_LIMIT };
