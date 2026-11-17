import { z } from 'zod';
import type { AuditEvent } from './audit.js';
import { edgeRefSchema, elementRefSchema, nodeSchema } from './graph.js';
import { codePoints } from './investigations.js';
import { referenceTextSchema } from './entities.js';
import { EXPAND_DIRECTIONS, EXPAND_SORTS } from './expand.js';
import { searchResultSchema, searchTextSchema } from './search.js';
import { degreePreviewSchema } from './degree-preview.js';
import { patternRunResponseSchema } from './pattern-run.js';
import { derivedNeighborsResponseSchema } from './derived-neighbors.js';
import { derivedEdgeDetailSchema } from './edge-detail.js';
import { expandResponseSchema } from './expand.js';
import { fileQueryResultSchema } from './file-query.js';
import { pathsParamsSchema, pathsResponseSchema } from './paths.js';
import { linkedEntitiesParamsSchema, sharedAttributeParamsSchema, templateRunResponseSchema, windowSchema } from './template-run.js';

const name = z.string().min(1);
const anchor = z.strictObject({ entityType: name, stableId: referenceTextSchema });

/**
 * The typed parameters of each template an intent can name. Each holds what the template's request holds that an intent may choose, and none holds a source, a mask, a cursor or a continue flag: the application sets those.
 * `limit` is at least 1; its upper bound is the source's, checked when the run is made.
 */
export const ASK_TEMPLATE_PARAMS = {
  'shared-attribute': sharedAttributeParamsSchema,
  'linked-entities': linkedEntitiesParamsSchema,
  entity: z.strictObject({ ref: anchor }),
  'degree-preview': z.strictObject({ ref: anchor }),
  expand: z.strictObject({
    ref: anchor,
    relTypes: z.array(name).min(1).optional(),
    neighborTypes: z.array(name).min(1),
    direction: z.enum(EXPAND_DIRECTIONS).optional(),
    sort: z.enum(EXPAND_SORTS).optional(),
    window: windowSchema.optional(),
    limit: z.number().int().min(1).optional(),
  }),
  'derived-rule-run': z.strictObject({ ref: anchor, ruleId: name }),
  'derived-edge-support': z.strictObject({ ruleId: name, ends: z.tuple([anchor, anchor]) }),
  search: z.strictObject({ entityTypes: z.array(name).min(1), text: searchTextSchema }),
  'shortest-paths': pathsParamsSchema,
} as const;

export const ASK_TEMPLATE_IDS = Object.keys(ASK_TEMPLATE_PARAMS) as (keyof typeof ASK_TEMPLATE_PARAMS)[];

/** The template identifier of a run of one of the investigator's saved patterns; it is not a template of the catalog, so the classifier is told of it by the pattern catalog of the request. */
export const SAVED_PATTERN_TEMPLATE_ID = 'saved-pattern';
export const SAVED_PATTERN_TEMPLATE_VERSION = 1;

/** The parameters of a saved-pattern run as it is stored. */
export const storedSavedPatternParamsSchema = z.strictObject({ patternId: z.uuid(), patternVersion: z.number().int().min(1), ref: anchor.optional() });
/** The `templateId` of the result of a file query in a run result: the file query has no template of the catalog. */
export const FILE_QUERY_RESULT_ID = 'file-query';

export const ASK_RUN_OUTCOMES = ['complete', 'partial', 'failed'] as const;

/** The longest text an entity value of a question may hold. */
export const ASK_ENTITY_TEXT_MAX_LENGTH = 256;

/** What a run of an intent answers: the template it ran and the answer of the service its manual route uses, whole, so a run reads exactly as the person's own click would. */
export const askRunResultSchema = z.union([
  z.strictObject({ templateId: z.literal('shared-attribute'), result: templateRunResponseSchema }),
  z.strictObject({ templateId: z.literal('linked-entities'), result: templateRunResponseSchema }),
  z.strictObject({ templateId: z.literal('entity'), result: nodeSchema }),
  z.strictObject({ templateId: z.literal('degree-preview'), result: degreePreviewSchema }),
  z.strictObject({ templateId: z.literal('expand'), result: expandResponseSchema }),
  z.strictObject({ templateId: z.literal('derived-rule-run'), result: derivedNeighborsResponseSchema }),
  z.strictObject({ templateId: z.literal('derived-edge-support'), result: derivedEdgeDetailSchema }),
  z.strictObject({ templateId: z.literal('search'), result: searchResultSchema }),
  z.strictObject({ templateId: z.literal('shortest-paths'), result: pathsResponseSchema }),
  /** A run of a file query of the Ask folder: the typed answer of the gate, nodes and relationships of the source's mapping. */
  z.strictObject({ templateId: z.literal(FILE_QUERY_RESULT_ID), result: fileQueryResultSchema }),
  /** A run of a saved pattern is the saved run's own answer for its kind: a pattern answer with `matches`, or a template answer for a saved run of a preset; a pattern that cannot run is a refusal. */
  z.strictObject({ templateId: z.literal(SAVED_PATTERN_TEMPLATE_ID), result: z.union([patternRunResponseSchema, templateRunResponseSchema]) }),
]);

/** Whether a result is the stop of a run that would read more than the source allows without being asked again: the run was given back, so the answer carries the token to continue it. */
export function isHeavyResult(run: AskRunResult): boolean {
  return (run.templateId === 'shared-attribute' || run.templateId === 'linked-entities' || run.templateId === 'shortest-paths' || run.templateId === SAVED_PATTERN_TEMPLATE_ID) && run.result.status === 'heavy';
}

/** How the sentence of one path of a path answer begins (`Path 2, 3 hops.`): the server writes it and a card finds the markers of its own path by it. The comma keeps `Path 1,` from matching `Path 11,`. */
export const pathSentenceStart = (position: number): string => `Path ${position},`;

/** Whether a sentence of a summary is the sentence of one path (it carries that path's citations and is shown on its card, not in the answer). */
export const isPathSentence = (text: string): boolean => /^Path \d+,/.test(text);

/** The limits of a summary, in sentences, characters of a sentence and citations. Working limits, not taken from a source. */
export const ASK_SUMMARY_MAX_SENTENCES = 12;
export const ASK_SUMMARY_MAX_SENTENCE_LENGTH = 300;
export const ASK_SUMMARY_MAX_CITATIONS = 40;
/** The longest key a citation has: a handle of one answer, not an element ID of the source. */
export const ASK_SUMMARY_MAX_KEY_LENGTH = 16;

const summaryKey = z.string().min(1).max(ASK_SUMMARY_MAX_KEY_LENGTH);
const summaryText = z.string().min(1).refine((value) => codePoints(value) <= ASK_SUMMARY_MAX_SENTENCE_LENGTH, { message: `at most ${ASK_SUMMARY_MAX_SENTENCE_LENGTH} characters` }).meta({ maxLength: ASK_SUMMARY_MAX_SENTENCE_LENGTH });

/** A sentence of a summary and the keys of the citations it rests on: at least one. */
export const askSummarySentenceSchema = z.strictObject({ text: summaryText, cites: z.array(summaryKey).min(1).max(ASK_SUMMARY_MAX_CITATIONS) });

/** What a key stands for: a node or a relationship the result lists, with its type and title as they arrived (the title of a relationship is its type with the titles of both ends). */
export const askSummaryCitationSchema = z.strictObject({ key: summaryKey, element: z.union([elementRefSchema, edgeRefSchema]), type: z.string().min(1), title: z.string() });

/**
 * The summary of a run: sentences built from the result alone, each citing elements the result lists, and one sentence that says what was left out. Every sentence has a key, every key has a citation,
 * every citation is cited, the keys are unique and the citations are of one source. The schema cannot see the result: the route checks that the cited elements are the result's and the source is the run's.
 */
export const askSummarySchema = z
  .strictObject({
    sentences: z.array(askSummarySentenceSchema).min(1).max(ASK_SUMMARY_MAX_SENTENCES),
    citations: z.array(askSummaryCitationSchema).min(1).max(ASK_SUMMARY_MAX_CITATIONS),
    omissions: summaryText.optional(),
  })
  .superRefine((summary, context) => {
    const keys = summary.citations.map((citation) => citation.key);
    if (new Set(keys).size !== keys.length) context.addIssue({ code: 'custom', message: 'a key is held by one citation only', path: ['citations'] });
    const cited = new Set(summary.sentences.flatMap((sentence) => sentence.cites));
    const known = new Set(keys);
    if ([...cited].some((key) => !known.has(key))) context.addIssue({ code: 'custom', message: 'a sentence cites a key no citation holds', path: ['sentences'] });
    if (keys.some((key) => !cited.has(key))) context.addIssue({ code: 'custom', message: 'every citation is cited by a sentence', path: ['citations'] });
    if (new Set(summary.citations.map((citation) => citation.element.sourceId)).size > 1) context.addIssue({ code: 'custom', message: 'the citations are of one source', path: ['citations'] });
  });

export type AskRunResult = z.infer<typeof askRunResultSchema>;
export type AskSummary = z.infer<typeof askSummarySchema>;
export type AskSummaryCitation = z.infer<typeof askSummaryCitationSchema>;

export type AskAvailability = { readonly available: true } | { readonly available: false; readonly reason: string };

/** What a pattern needs of the intent that names it, by its key: the type of the entity it starts at, and whether the question gives that entity or the pattern holds it. */
export interface AskPatternEntry {
  readonly anchorType: string;
  readonly startingEntity: 'asked' | 'held';
}

/** The saved patterns offered for one question: the text and what a key of it stands for. Nothing in it is a pattern's id or an owner. */
export interface AskPatternCatalog {
  readonly text: string;
  /** Whether the catalog leaves out saved patterns the caller may run, because there are more than it holds. */
  readonly cut: boolean;
  readonly entries: ReadonlyMap<string, AskPatternEntry>;
}

/**
 * One step of a saved pattern as an intent may be told of it: types and kinds only, never a property, a value or a name. The structural fields of a step carry the only numbers it may hold: the fan's threshold and the delay's length and unit are bounds of the
 * pattern's shape (the threshold bounded by the source's count cap, the length by the contract's ceiling), not a value of the data, a condition or a time; a field a step does not use is absent.
 */
export interface AskPatternStep {
  readonly relationshipTypes: readonly string[];
  readonly direction: 'out' | 'in' | 'both';
  readonly arrivesAt: string;
  readonly conditions: readonly { readonly on: 'neighbor' | 'relationship'; readonly kind: 'eq' | 'in' | 'between' }[];
  readonly windowed: boolean;
  /** The step's relationship is at or after the previous step's in time. */
  readonly orderedAfterPrevious?: true;
  /** The step's relationship is no later than the previous step's plus this length, in the unit the definition wrote. */
  readonly within?: { readonly unit: 'minutes' | 'hours' | 'days'; readonly amount: number };
  /** The step starts only from a node with at least this many distinct neighbours over the step. */
  readonly fanAtLeast?: number;
  /** The step arrives at the starting entity itself (the last step of a cycle). */
  readonly closesAtAnchor?: true;
}

/** The structure of a saved pattern that may reach the classifier. It has no field for a name, a description, a value, an owner, an identifier or a time. */
export type AskPatternProjection =
  | {
      readonly kind: 'definition';
      readonly anchorType: string;
      readonly startingEntity: 'asked' | 'held';
      readonly steps: readonly AskPatternStep[];
    }
  | {
      /** A saved run of one of the source's presets: the template, the types and relationship types the preset binds, and the numbers the run was saved with. */
      readonly kind: 'preset-run';
      readonly template: 'shared-attribute' | 'linked-entities';
      readonly anchorType: string;
      readonly startingEntity: 'asked' | 'held';
      readonly otherType: string;
      readonly relationshipTypes: readonly string[];
      readonly direction?: 'out' | 'in' | 'both';
      readonly maxHops?: number;
      readonly minShared?: number;
      readonly windowed: boolean;
    };

/** What the application lists of a caller's saved patterns on a source: the offers, and whether it left some out because there are more than a catalog holds. */
export interface AskPatternListing {
  readonly offers: readonly AskPatternOffer[];
  readonly cut: boolean;
}

/** A pattern the caller may run, as the application hands it to the extension: the structure, and the id, version and typed name that only the application and the checks of the extension may hold. */
export interface AskPatternOffer {
  readonly id: string;
  readonly version: number;
  readonly name: string;
  readonly projection: AskPatternProjection;
}

/** Why Ask did not answer a question. Each cause has one fixed sentence (`ASK_REFUSAL_SENTENCES`); no sentence holds a word of the model, the question or the folder. */
export const ASK_REFUSAL_CAUSES = [
  'no-intent',
  'unknown-intent',
  'bad-reply',
  'model-declined',
  'model-failed',
  'no-ask-for-source',
  'unavailable',
  'missing-inputs',
  'extra-inputs',
  'invalid-inputs',
  'nothing-found',
] as const;

export type AskRefusalCause = (typeof ASK_REFUSAL_CAUSES)[number];

/** The values the classifier extracted from a question, named as the parameters of the intent it chose. */
export type AskEntities = Readonly<Record<string, string>>;

/** Who asked and about which source: ids only, so the audit of the call can name the actor. */
export interface AskClassifyInput {
  readonly sourceId: string;
  /** The question as typed, at most `ASK_QUESTION_MAX_CODE_POINTS` code points and not blank. */
  readonly question: string;
  readonly actorId: string;
  readonly actorRole: Exclude<AuditEvent['actorRole'], 'system'>;
  readonly traceId: string;
  readonly investigationId?: string;
  /** The catalog text of the caller's own saved patterns on this source, built by the route; when it is given the model may answer the intent `saved-pattern`, and the text is sent after the question. */
  readonly patternCatalog?: string;
}

export type AskClassification = { readonly ok: true; readonly intent: string; readonly entities: AskEntities } | { readonly ok: false; readonly cause: AskRefusalCause };

/** The longest question Ask takes, in code points. */
export const ASK_QUESTION_MAX_CODE_POINTS = 1000;

/** The seam Ask runs through: the Community default says it is not available; an installed one classifies a question into an intent and its entities, or says why it did not. */
export interface AskClassifier {
  availability(): AskAvailability;
  classify(input: AskClassifyInput, signal: AbortSignal): Promise<AskClassification>;
}
