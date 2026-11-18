import type { Socket } from 'node:net';
import { z } from 'zod';
import { ASK_INTENT_NAME } from './ask-folder.js';
import { ASK_TEMPLATE_IDS, ASK_REFUSAL_CAUSES, SAVED_PATTERN_TEMPLATE_ID } from './ask.js';
import { ERROR_CODES } from './error-codes.js';
import { roleSchema } from './me.js';

/** The id the system principal and the system actor of an event are stored under. */
export const SYSTEM_ACTOR_ID = '00000000-0000-4000-8000-000000000000';

export const AUDIT_RESULTS = ['success', 'denied', 'partial', 'refused', 'failed'] as const;
export type AuditResult = (typeof AUDIT_RESULTS)[number];

declare const wholeNumber: unique symbol;
/** A count of tokens: a whole number that is not negative, which only `tokenCount` and `isTokenCount` make, so a literal such as `1.5` is a type error. */
export type TokenCount = number & { readonly [wholeNumber]: true };

export function isTokenCount(value: number): value is TokenCount {
  return Number.isSafeInteger(value) && value >= 0;
}

export function tokenCount(value: number): TokenCount {
  if (!isTokenCount(value)) throw new RangeError('a token count is a whole number that is not negative');
  return value;
}

const tokenCountSchema = z.custom<TokenCount>((value) => typeof value === 'number' && isTokenCount(value));

/** What a model call leaves in the audit event: a model reference, a prompt id and version, the SHA-256 of the fixed instructions of the prompt, and token counts; never a prompt, a summary or a value. */
export interface AiAuditDetail {
  readonly modelRef: string;
  readonly promptId: string;
  readonly promptVersion: string;
  /** The SHA-256, as 64 lower-case hexadecimal digits, of the fixed instructions of the prompt (of nothing when it has none), never of the values that follow them: a hash of text that holds a value could be confirmed by guessing the value. */
  readonly promptSha256: string;
  /** The record of the case summary this call belongs to; absent for Ask. */
  readonly runId?: string;
  /** The input tokens after the last cache breakpoint, as the provider states them; with caching, the total input is this plus the two cache counts. */
  readonly tokensIn: TokenCount | 'unknown';
  readonly tokensOut: TokenCount | 'unknown';
  /** The input tokens the call read from the provider's prompt cache; absent on an event written before caching existed. */
  readonly cacheReadTokens?: TokenCount | 'unknown';
  /** The input tokens the call wrote to the provider's prompt cache; absent on an event written before caching existed. */
  readonly cacheWriteTokens?: TokenCount | 'unknown';
}

const tokensSchema = z.union([tokenCountSchema, z.literal('unknown')]);
/** A model reference, a prompt id or a prompt version: a short code with no space, so a prompt or a summary cannot be carried in it. The length is a working limit, not taken from a source. */
const MAX_LABEL_LENGTH = 200;
const label = z.string().min(1).max(MAX_LABEL_LENGTH).regex(/^[A-Za-z0-9._:/-]+$/);
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

export const aiAuditDetailSchema = z.strictObject({
  modelRef: label,
  promptId: label,
  promptVersion: label,
  promptSha256: sha256Hex,
  /** The record of the case summary this call belongs to; absent for Ask. */
  runId: z.uuid().optional(),
  /** The saved patterns the call offered: how many, and the SHA-256 of the text that was sent, which holds structure and keys only. Absent when no pattern was offered. */
  patternCatalog: z.strictObject({ count: z.number().int().min(1), sha256: sha256Hex }).optional(),
  tokensIn: tokensSchema,
  tokensOut: tokensSchema,
  cacheReadTokens: tokensSchema.optional(),
  cacheWriteTokens: tokensSchema.optional(),
});

export function parseAiAuditDetail(value: unknown): AiAuditDetail {
  return aiAuditDetailSchema.parse(value);
}

const wholeCount = z.number().int().nonnegative();

/**
 * What a question of Ask leaves in the audit event: the intent, whether it was a template or a file query, the outcome or the cause of a refusal, the template, the SHA-256 of the file query's text, a keyed hash of the
 * parameters and the number of elements the result listed; never a value, a question or a sentence. The parameters' hash is an HMAC made with the signing capability of the application over the canonical text
 * `['ask-run-params', 1, intent, entities]`, so a short value cannot be confirmed by guessing; the key is the application's.
 */
const ASK_RUN_CAUSES = [...ASK_REFUSAL_CAUSES, 'continue-invalid', ...ERROR_CODES.map((code) => code.toLowerCase().replace(/_/g, '-'))] as [string, ...string[]];

export const askRunAuditDetailSchema = z.strictObject({
  intent: label.optional(),
  kind: z.enum(['template', 'query']),
  outcome: z.enum(['complete', 'partial', 'refused', 'failed']),
  cause: z.enum(ASK_RUN_CAUSES).optional(),
  templateId: z.enum([...ASK_TEMPLATE_IDS, SAVED_PATTERN_TEMPLATE_ID]).optional(),
  querySha256: sha256Hex.optional(),
  paramsHash: sha256Hex.optional(),
  rowCount: wholeCount.optional(),
  /** The id and version of the saved pattern a run of the intent `saved-pattern` ran; its name is never recorded. */
  patternId: z.uuid().optional(),
  patternVersion: z.number().int().min(1).optional(),
});

export type AskRunAuditDetail = z.infer<typeof askRunAuditDetailSchema>;

/** How a click of the case summary ended, as the closing audit event records it. */
export const CASE_SUMMARY_OUTCOMES = ['ok', 'tooLarge', 'timeLimit', 'unavailable', 'format', 'timeout', 'unreachable', 'rate-limited', 'refused', 'truncated', 'rejected', 'provider-error', 'bad-reply', 'read-failed', 'error', 'cancelled', 'partial', 'unsupported'] as const;

/**
 * What a click of the case summary leaves in its closing audit event: how many elements the request named, the SHA-256 of their references (so one request is told from another without holding a reference), the
 * calls made, the model and prompt that were used, and how it ended; never an instruction, the text sent, a reply or an element.
 */
export const caseSummaryAuditDetailSchema = z.strictObject({
  elements: wholeCount,
  elementsSha256: sha256Hex,
  calls: wholeCount,
  modelRef: label.optional(),
  promptId: label.optional(),
  promptVersion: label.optional(),
  instructionsSha256: sha256Hex.optional(),
  /** The record of the click's calls; absent when the click ended before it was written. */
  runId: z.uuid().optional(),
  outcome: z.enum(CASE_SUMMARY_OUTCOMES),
  /** The sentences the checks kept and removed in the last reply they checked; absent when none was checked. */
  sentencesKept: wholeCount.optional(),
  sentencesRemoved: wholeCount.optional(),
});

export type CaseSummaryAuditDetail = z.infer<typeof caseSummaryAuditDetailSchema>;

/** What a Copy to notes leaves in its audit event: the run of the click the draft came from and how many sentences were kept, not kept, and whether the token had been copied; never a sentence. */
export const notesAuditDetailSchema = z.strictObject({ runId: z.uuid().optional(), copied: wholeCount, notCopied: wholeCount, alreadyCopied: z.boolean() });

export type NotesAuditDetail = z.infer<typeof notesAuditDetailSchema>;

/** How an assistant turn ended, as its closing audit event records it. */
export const ASSISTANT_TURN_OUTCOMES = ['answered', 'refused', 'failed', 'cancelled'] as const;
export type AssistantTurnOutcome = (typeof ASSISTANT_TURN_OUTCOMES)[number];

/**
 * What an assistant turn leaves in its closing audit event: the route, how it ended, the intent or template, the keyed hash of the parameters (the one Ask makes), how many reads and model calls it made, the number of
 * elements its accepted summary cited, the model and prompt of the router call, its tokens and the record of its calls; never a message, a reply, a value or an instruction. A count the turn does not have is absent, never 0.
 */
export const assistantTurnAuditDetailSchema = z.strictObject({
  route: z.enum(['ask', 'view', 'refuse']).optional(),
  outcome: z.enum(ASSISTANT_TURN_OUTCOMES),
  cause: label.optional(),
  failureKind: label.optional(),
  intent: label.optional(),
  templateId: z.enum([...ASK_TEMPLATE_IDS, SAVED_PATTERN_TEMPLATE_ID]).optional(),
  paramsHash: sha256Hex.optional(),
  steps: wholeCount.optional(),
  citedElements: wholeCount.optional(),
  modelCalls: wholeCount,
  modelRef: label.optional(),
  promptId: label.optional(),
  promptVersion: label.optional(),
  instructionsSha256: sha256Hex.optional(),
  tokensIn: tokensSchema.optional(),
  tokensOut: tokensSchema.optional(),
  runId: z.uuid().optional(),
});

export type AssistantTurnAuditDetail = z.infer<typeof assistantTurnAuditDetailSchema>;

/** Why a call to an AI route was refused, as the event `ai.route_refused` records it: the feature is switched off, or the routes are mounted while no AI provider is configured. */
const AI_ROUTE_REFUSAL_REASONS = ['ai-off', 'no-provider'] as const;

/** The per-action fields of an audit event, one shape at a time: every shape holds counts and codes only. */
export const auditDetailSchema = z.union([
  z.strictObject({ reason: z.enum(['cancelled', 'timeout', ...AI_ROUTE_REFUSAL_REASONS]) }),
  z.strictObject({ target: z.enum(['entity', 'evidence']), type: z.string() }),
  z.strictObject({ counts: z.strictObject({ nodes: wholeCount, edges: wholeCount, missing: wholeCount }) }),
  z.strictObject({
    export: z.strictObject({
      format: z.enum(['json', 'csv']),
      entities: wholeCount.optional(),
      relationships: wholeCount.optional(),
      maskedFields: wholeCount.optional(),
      refusal: z.enum(['access-changed', 'export-source-changed', 'summary-refused']).optional(),
      /** That the AI case summary was included: the run it came from and how many sentences were kept and dropped; never a sentence. */
      summary: z.strictObject({ runId: z.string().min(1), kept: wholeCount, dropped: wholeCount }).optional(),
    }),
  }),
  z.strictObject({ ai: aiAuditDetailSchema }),
  z.strictObject({ askRun: askRunAuditDetailSchema }),
  z.strictObject({ summary: caseSummaryAuditDetailSchema }),
  z.strictObject({ notes: notesAuditDetailSchema }),
  z.strictObject({ turn: assistantTurnAuditDetailSchema }),
  z.strictObject({ fileQuery: z.strictObject({ intent: z.string().regex(ASK_INTENT_NAME).optional(), queryHash: z.string().regex(/^[0-9a-f]{64}$/).optional() }), reason: z.enum(['cancelled', 'timeout']).optional() }),
]);

export type AuditDetail =
  | { readonly reason: 'cancelled' | 'timeout' | (typeof AI_ROUTE_REFUSAL_REASONS)[number]; readonly target?: never; readonly type?: never; readonly counts?: never; readonly export?: never; readonly ai?: never; readonly fileQuery?: never; readonly askRun?: never }
  | { readonly target: 'entity' | 'evidence'; readonly type: string; readonly reason?: never; readonly counts?: never; readonly export?: never; readonly ai?: never; readonly fileQuery?: never; readonly askRun?: never }
  /** How many items a read by references returned and could not find: counts only, never a value or an ID. */
  | { readonly counts: Readonly<Record<'nodes' | 'edges' | 'missing', number>>; readonly reason?: never; readonly target?: never; readonly type?: never; readonly export?: never; readonly ai?: never; readonly fileQuery?: never; readonly askRun?: never }
  /** What an export or a download of one was: the format, and for an export how many items it holds and how many fields were masked; never a value, an ID or a file name; a refused download adds which of the two refusals it was. */
  | {
      readonly export: { readonly format: 'json' | 'csv' | 'png'; readonly entities?: number; readonly relationships?: number; readonly maskedFields?: number; readonly refusal?: 'access-changed' | 'export-source-changed' | 'summary-refused'; readonly summary?: { readonly runId: string; readonly kept: number; readonly dropped: number } };
      readonly counts?: never;
      readonly reason?: never;
      readonly target?: never;
      readonly type?: never;
      readonly ai?: never;
      readonly askRun?: never;
      readonly fileQuery?: never;
    }
  | { readonly ai: AiAuditDetail; readonly counts?: never; readonly export?: never; readonly reason?: never; readonly target?: never; readonly type?: never; readonly fileQuery?: never; readonly askRun?: never }
  /** A run of a file query of the Ask folder: the intent's name and the SHA-256 of its query (each present only when the folder holds the intent) and, for a read that was cancelled or timed out, the reason; never an entity value, a query text or a row. */
  | { readonly fileQuery: { readonly intent?: string; readonly queryHash?: string }; readonly reason?: 'cancelled' | 'timeout'; readonly ai?: never; readonly counts?: never; readonly export?: never; readonly target?: never; readonly type?: never; readonly askRun?: never }
  /** What a question of Ask was: the intent, the outcome or cause, and hashes and counts only. */
  | { readonly askRun: AskRunAuditDetail; readonly ai?: never; readonly counts?: never; readonly export?: never; readonly reason?: never; readonly target?: never; readonly type?: never; readonly fileQuery?: never }

  /** How an assistant turn ended: the route, outcome, hashes and counts only. */
  | { readonly turn: AssistantTurnAuditDetail; readonly summary?: never; readonly notes?: never; readonly ai?: never; readonly counts?: never; readonly export?: never; readonly reason?: never; readonly target?: never; readonly type?: never; readonly fileQuery?: never; readonly askRun?: never }
  /** What a Copy to notes was: the run, and counts. */
  | { readonly notes: NotesAuditDetail; readonly summary?: never; readonly ai?: never; readonly counts?: never; readonly export?: never; readonly reason?: never; readonly target?: never; readonly type?: never; readonly fileQuery?: never; readonly askRun?: never }
  /** What a click of the case summary was: counts, hashes, the model and prompt used and the outcome. */
  | { readonly summary: CaseSummaryAuditDetail; readonly notes?: never; readonly ai?: never; readonly counts?: never; readonly export?: never; readonly reason?: never; readonly target?: never; readonly type?: never; readonly fileQuery?: never; readonly askRun?: never }

export function parseAuditDetail(value: unknown): AuditDetail {
  return auditDetailSchema.parse(value);
}

export interface AuditEvent {
  readonly actorId: string;
  /** `system` for work no person started, such as the purge of deleted investigations; `null` is the system principal of a read. */
  readonly actorRole: z.infer<typeof roleSchema> | null | 'system';
  readonly action: string;
  readonly result: AuditResult;
  readonly sourceId?: string;
  readonly investigationId?: string;
  readonly resourceType?: string;
  readonly resourceRef?: string;
  readonly traceId: string;
  /** Per-action fields of the event; the Community sink keeps none. */
  readonly detail?: AuditDetail;
}

/** A database transaction a privileged event is inserted through, so it commits or rolls back with the change it records. */
export interface AuditTransaction {
  query(text: string, values?: readonly unknown[]): Promise<unknown>;
}

/** What a caller may hand a sink beside the event. */
export interface AuditWriteOptions {
  /** Aborted when the writer stops waiting for the write; a sink ends the statement it started. */
  readonly signal?: AbortSignal;
  /** The transaction of the change the event records; a sink that stores events inserts through it and not through a connection of its own. */
  readonly transaction?: AuditTransaction;
}

export interface AuditSink {
  record(event: AuditEvent, options?: AuditWriteOptions): Promise<void>;
  /** Counts and logs, by its ids, an event the caller could not build; the queue of the application has it, a sink that stores events does not. */
  failed?(event: AuditEvent): void;
}

/** What the preview's audit sink is given when it is built: the application's own database login and the limits that login's pool keeps, so the sink repeats no number of its own. */
export interface AuditSinkContext {
  readonly databaseUrl: string;
  readonly poolSize: number;
  readonly connectionTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly queryTimeoutMs: number;
  /** Makes the socket one connection uses, so the sink looks the database name up through the application's address cache; absent, each connection looks the name up itself. */
  readonly connectionStream?: () => Socket;
  /** Makes the version 7 uuid of a row. */
  readonly newId: () => string;
  readonly onConnectionError: () => void;
}

export interface MountedAuditSink {
  readonly sink: AuditSink;
  /** Ends the sink's connections; a second call does nothing. */
  close(): Promise<void>;
}
