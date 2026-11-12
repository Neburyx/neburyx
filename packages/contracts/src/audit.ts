import type { Socket } from 'node:net';
import { z } from 'zod';
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

/** What a model call leaves in the audit event: a model reference, a prompt id and version, the SHA-256 of the prompt template used, the names of the `pii` properties it held and token counts; never a prompt, a summary or a value. */
export interface AiAuditDetail {
  readonly modelRef: string;
  readonly promptId: string;
  readonly promptVersion: string;
  /** The SHA-256, as 64 lower-case hexadecimal digits, of the prompt template used (the built-in text or the override file's bytes), never of the text with the request filled in: a hash of the filled text could be confirmed by guessing a value. */
  readonly promptSha256: string;
  /** The `type.property` names of the `pii` properties the request held, never their values; absent when none was sent, never an empty list. */
  readonly piiPropertiesSent?: readonly string[];
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
/** A property name: no whitespace and a bounded length. The bounds are working limits, not taken from a source. */
const MAX_PROPERTY_NAME_LENGTH = 200;
const MAX_PII_PROPERTIES = 100;
const propertyName = z.string().min(1).max(MAX_PROPERTY_NAME_LENGTH).regex(/^\S+$/);

export const aiAuditDetailSchema = z.strictObject({
  modelRef: label,
  promptId: label,
  promptVersion: label,
  promptSha256: sha256Hex,
  piiPropertiesSent: z.array(propertyName).min(1).max(MAX_PII_PROPERTIES).optional(),
  tokensIn: tokensSchema,
  tokensOut: tokensSchema,
  cacheReadTokens: tokensSchema.optional(),
  cacheWriteTokens: tokensSchema.optional(),
});

export function parseAiAuditDetail(value: unknown): AiAuditDetail {
  return aiAuditDetailSchema.parse(value);
}

const wholeCount = z.number().int().nonnegative();

/** The per-action fields of an audit event, one shape at a time: every shape holds counts and codes only. */
export const auditDetailSchema = z.union([
  z.strictObject({ reason: z.enum(['cancelled', 'timeout']) }),
  z.strictObject({ target: z.enum(['entity', 'evidence']), type: z.string() }),
  z.strictObject({ counts: z.strictObject({ nodes: wholeCount, edges: wholeCount, missing: wholeCount }) }),
  z.strictObject({
    export: z.strictObject({
      format: z.enum(['json', 'csv']),
      entities: wholeCount.optional(),
      relationships: wholeCount.optional(),
      maskedFields: wholeCount.optional(),
      refusal: z.enum(['access-changed', 'export-source-changed']).optional(),
    }),
  }),
  z.strictObject({ ai: aiAuditDetailSchema }),
]);

export type AuditDetail =
  | { readonly reason: 'cancelled' | 'timeout'; readonly target?: never; readonly type?: never; readonly counts?: never; readonly export?: never; readonly ai?: never }
  | { readonly target: 'entity' | 'evidence'; readonly type: string; readonly reason?: never; readonly counts?: never; readonly export?: never; readonly ai?: never }
  /** How many items a read by references returned and could not find: counts only, never a value or an ID. */
  | { readonly counts: Readonly<Record<'nodes' | 'edges' | 'missing', number>>; readonly reason?: never; readonly target?: never; readonly type?: never; readonly export?: never; readonly ai?: never }
  /** What an export or a download of one was: the format, and for an export how many items it holds and how many fields were masked; never a value, an ID or a file name; a refused download adds which of the two refusals it was. */
  | {
      readonly export: { readonly format: 'json' | 'csv'; readonly entities?: number; readonly relationships?: number; readonly maskedFields?: number; readonly refusal?: 'access-changed' | 'export-source-changed' };
      readonly counts?: never;
      readonly reason?: never;
      readonly target?: never;
      readonly type?: never;
      readonly ai?: never;
    }
  | { readonly ai: AiAuditDetail; readonly counts?: never; readonly export?: never; readonly reason?: never; readonly target?: never; readonly type?: never };

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

export interface AuditSink {
  record(event: AuditEvent): Promise<void>;
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
