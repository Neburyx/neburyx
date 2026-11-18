import { z } from 'zod';
import { ASK_FOLDER_LIMITS, isParameterName } from './ask-folder.js';
import { ASK_SUMMARY_MAX_CITATIONS, ASK_TEMPLATE_IDS, SAVED_PATTERN_TEMPLATE_ID } from './ask.js';
import { ASSISTANT_VIEW_KEYS_MAX } from './assistant-turn.js';
import { edgeRefSchema, elementRefSchema } from './graph.js';

const wholeCount = z.number().int().nonnegative();
const label = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:/-]+$/);
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

/** The routes and ends of a turn that a thread keeps: a turn that failed, was cancelled or was not let through leaves nothing. */
export const THREAD_TURN_ROUTES = ['ask', 'view', 'refuse'] as const;
export const THREAD_TURN_OUTCOMES = ['answered', 'refused'] as const;

/** The element a parameter of an intent resolved to, with the role (the parameter's name) it had; never the text the person typed. */
export const threadEntitySchema = z.strictObject({ role: z.string().refine(isParameterName, { message: 'a parameter name' }), ref: elementRefSchema });

/** A thing a turn cited: an element or a relationship, as a summary cites it. */
export const threadCitationRefSchema = z.union([elementRefSchema, edgeRefSchema]);

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
  })
  .refine((turn) => turn.route === 'view' || turn.citationRefs.length <= ASK_SUMMARY_MAX_CITATIONS, { message: 'an Ask answer cites at most as many things as a summary holds', path: ['citationRefs'] });

export type AssistantThreadTurnWrite = z.infer<typeof assistantThreadTurnWriteSchema>;

/** One stored turn as the panel is told of it: what kind of turn it was and how it ended, never a hash, a reference, a token or a run id. */
export const assistantThreadTurnSchema = z.strictObject({
  seq: z.number().int().min(1),
  at: z.iso.datetime(),
  route: z.enum(THREAD_TURN_ROUTES),
  outcome: z.enum(THREAD_TURN_OUTCOMES),
  cause: label.optional(),
  intent: label.optional(),
  citedElements: wholeCount,
  steps: wholeCount,
});

/** How many of the most recent turns of a thread one read gives, and the most a setting may raise it to. Working limits, not taken from a source, to be measured with the other provisional settings; they bound the answer and what the panel draws and trim nothing that is stored. */
export const THREAD_READ_TURNS_DEFAULT = 100;
export const THREAD_READ_TURNS_CEILING = 500;

/**
 * `GET /v1/assistant/investigations/{id}/thread`: the caller's own thread (its most recent turns, at most `THREAD_READ_TURNS_CEILING`, and how many older ones there are), and when the caller's previous thread was cleared (the investigation was closed),
 * if it was and no thread has been started since.
 */
export const assistantThreadResponseSchema = z.strictObject({ turns: z.array(assistantThreadTurnSchema).max(THREAD_READ_TURNS_CEILING), earlierTurns: wholeCount, previousThreadClearedAt: z.iso.datetime().nullable() });

export type AssistantThreadResponse = z.infer<typeof assistantThreadResponseSchema>;
