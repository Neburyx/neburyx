import { z, type ZodType } from 'zod';
import type { AiSettings, AiStatusResponse } from './ai.js';
import type { AskFolder } from './ask-folder.js';
import type { ReadRefsRequest } from './read-refs.js';
import type { AiNotesCapability } from './ai-notes.js';
import type { CaseSummarizer, SummaryReading } from './summary.js';
import type { ASK_TEMPLATE_IDS, SAVED_PATTERN_TEMPLATE_ID, AskPatternListing, AskPatternOffer, AskClassifier, AskRunResult } from './ask.js';
import { SOURCE_UNAVAILABLE_REASONS } from './error-codes.js';
import type { AuditEvent, AuditSink, AuditSinkContext, MountedAuditSink } from './audit.js';

export type ExtensionRoutePermission = 'public' | 'principal';

export interface ExtensionRequest {
  readonly principalId: string;
  readonly principalRole: Exclude<AuditEvent['actorRole'], 'system'>;
  /** Whether the preview switch is on for this process, as decided at start-up; a route group that is not on refuses its calls. */
  readonly previewOn: boolean;
  readonly traceId: string;
  /** The application's queued audit member: recording returns at once and does not report a failed write, which the application counts and logs. */
  readonly audit: AuditSink;
  /** The body of a `POST` route, already parsed by the route's request schema. */
  readonly body?: unknown;
  /** The path parameters of the route, already parsed by its `params` schema. */
  readonly params?: unknown;
  /** The query of the route, already parsed by its `query` schema. */
  readonly query?: unknown;
  /** For a route that declares an `investigation`: the caller's investigation the path names and its source, read from the record and never from the body or the query. */
  readonly investigation?: { readonly id: string; readonly sourceId: string };
  /** The application's `AskClassifier`: the Community default unless the application was given another. */
  readonly askClassifier: AskClassifier;
  /** The application's `CaseSummarizer`: the Community default unless the application was given another. */
  readonly caseSummarizer: CaseSummarizer;
  /** The caller's policy version for a source, as the application holds it; absent, a route that binds a record to it refuses. */
  readonly policyVersion?: (sourceId: string) => string;
  /** Aborted when the client gives up the request. */
  readonly signal: AbortSignal;
  /** Sends an event to the client of a streamed request: the name of one of the route's `stream.events` and its members, checked against that event's schema. Absent unless the route declares a stream and the client asked for one. Nothing sent here is logged. */
  readonly emit?: (name: string, members: unknown) => void;
  /** Sets a header of the response, before the first byte of the answer or of a stream is sent; a header set after that is not sent. Absent where the route does not take part in a response (a test). */
  readonly setResponseHeader?: (name: string, value: string) => void;
  /** Signs a text: 64 lowercase hex characters, with a key that stays in the application. Absent, a route that needs it refuses. */
  readonly signText?: (canonical: string) => string;
  /**
   * The run of an intent of the caller on one source, through the gate: the factory is built for this request (its caller, trace ID and abort signal). The runner it returns reads only the source of the
   * scope, and its reads refuse, as `NOT_FOUND` and before anything is read, a source that is not configured or that the caller may not read; that refusal comes with the run, so a run that meets it is a failed run.
   */
  readonly askRunner?: (scope: AskRunScope) => AskRunner;
  /** Resolves when the caller may read the source and rejects with the `NOT_FOUND` refusal when the source is not configured or not the caller's; asked before anything is signed or sent. */
  readonly askSourceReadable?: (sourceId: string) => Promise<void>;
  /**
   * The elements of a view read again through the gate, for the caller and this request: the investigation must be the caller's and for the source, or the read is `NOT_FOUND`, as is a source the caller may not read. The references are
   * read through the reader the exports use, with the mask of the request: what the person may not export is left out, and the answer says how many references did not resolve, whether anything was left out and how many relationships are not yet retrieved.
   */
  readonly readElements?: (scope: ElementsScope, refs: ElementRefs) => Promise<SummaryReading>;
  /**
   * Elements of a source read again through the gate, for the caller and this request, with no investigation: the same reader as `readElements` (the mask of the request, what the person may not export left out and said
   * so, the references that did not resolve counted), for a route that has no investigation, such as Ask's. A source that is not configured or that the caller may not read is `NOT_FOUND`; at most `MAX_READ_REFS` references of
   * a kind in one call, more is refused.
   */
  readonly readSourceElements?: (scope: SourceElementsScope, refs: ElementRefs) => Promise<SummaryReading>;
  /** The AI notes of the caller's own drafts; absent, a route that stores or reads them refuses. */
  readonly aiNotes?: AiNotesCapability;
  /** Resolves when the investigation is the caller's and is for the source, and the source is as the investigation left it; rejects with `NOT_FOUND`, or the source-changed refusal, otherwise. */
  readonly investigationReadable?: (investigationId: string, sourceId: string) => Promise<void>;
  /** The caller's own saved patterns on a source (never the shared ones of other people), available against the mapping, newest changed first, at most as many as a catalog holds; `NOT_FOUND` for a source the caller may not read. */
  readonly askPatterns?: (sourceId: string) => Promise<AskPatternListing>;
  /** One of the caller's own saved patterns on a source, found by its id whatever the size of the listing: the same offer `askPatterns` would give, or undefined when it is not one the caller owns and may run now. */
  readonly askPatternFind?: (sourceId: string, id: string) => Promise<AskPatternOffer | undefined>;
  /** The plain-text descriptions the mapping gives the types of a source, read from the live mapping; mapping text only, never data. Absent, no description reaches a model. */
  readonly typeDescriptions?: (sourceId: string) => TypeDescriptions;
  /**
   * The property keys the mapping marks as personal data (`pii`) for each entity type of a source, which is exactly what the mask switch hides; a type with none is absent, a relationship has none; the title is the key `SENSITIVE_TITLE_KEY`
   * for a type whose title is built from such a property. Keys only, never a value; read from the live mapping. Absent, nothing can be classified as free of sensitive values.
   */
  readonly sensitiveKeys?: (sourceId: string) => ReadonlyMap<string, readonly string[]>;
  /** A fingerprint of those keys for every type of the source's mapping: it changes when any of them changes. */
  readonly sensitivityVersion?: (sourceId: string) => string;
}

/** The key under which `sensitiveKeys` names the title of an entity type that is built from a personal property. */
export const SENSITIVE_TITLE_KEY = '(title)';

/** The types of one source with the description the mapping gives each, when it gives one: the server tells which types have a meaning to quote and which have none. */
export interface TypeDescriptions {
  /** `keyed`: the identifier of an element of the type is a token the server made (its stable ID is also a personal field), so a typed value cannot stand for one. */
  readonly entityTypes: readonly { readonly type: string; readonly label: string; readonly displayName: string; readonly description?: string; readonly keyed?: boolean; /** The label and unit the mapping gives a property, by property name. */ readonly propertyDisplay?: Readonly<Record<string, { readonly label?: string; readonly unit?: string }>> }[];
  readonly relationshipTypes: readonly { readonly type: string; readonly description?: string }[];
}

/** The investigation and source a view belongs to and whether the personal data of its nodes is masked. */
export interface ElementsScope {
  readonly investigationId: string;
  readonly sourceId: string;
  readonly mask: boolean;
  /** Ends the read when it aborts, besides the request's own signal; the read never outlives it. */
  readonly signal?: AbortSignal;
}

/** The source whose elements are read, whether the personal data of its nodes is masked, and a signal that ends the read. */
export interface SourceElementsScope {
  readonly sourceId: string;
  readonly mask: boolean;
  readonly signal?: AbortSignal;
}

/** The references of the elements of a view, of the four kinds a read by references takes, in any number. */
export type ElementRefs = Pick<ReadRefsRequest, 'entities' | 'edges' | 'aggregates' | 'derived'>;

/** The source a run is made on and whether the personal data of the nodes of its result is masked. */
export interface AskRunScope {
  readonly sourceId: string;
  readonly mask: boolean;
}

/** What a run of an intent came to: the result, or the refusal of the gate with the code and details the manual route gives, never a partial result. */
export type AskRun = { readonly status: 'ok'; readonly result: AskRunResult } | { readonly status: 'refused'; readonly refusal: ExtensionRefusalFields };

/** What a runner runs: a template with its parameters, or the file query of an intent of the Ask folder with the entities' values as text (the gate takes the query from the folder, never from here). */
export type AskRunInput =
  | { readonly templateId: (typeof ASK_TEMPLATE_IDS)[number] | typeof SAVED_PATTERN_TEMPLATE_ID; readonly params: unknown }
  | { readonly fileQuery: { readonly intent: string; readonly values: Readonly<Record<string, string>> } };

export interface AskRunner {
  /** Runs a template with the parameters of the input, or a file query of the Ask folder with its values, as the service of the manual route would; `continue` is set only by a verified token and lets a heavy run read its bounded page. */
  run(asked: AskRunInput, options?: { readonly continue?: boolean }): Promise<AskRun>;
}

export type ExtensionRouteMethod = 'GET' | 'POST';

/** The media type of a streamed response: one JSON object a line (NDJSON). A client asks for it with `Accept`; any other client gets the JSON answer. */
export const EXTENSION_STREAM_MEDIA_TYPE = 'application/x-ndjson';
/** The event names the core owns: the last line of a stream, which carries the route's answer, and the line of a failure after the first event. A route's own events never use them. */
export const EXTENSION_STREAM_RESERVED_EVENTS = ['answer', 'error'] as const;

/** What makes a route streamable: the events it may send while its handler runs, and how long a stream may stay open. */
export interface ExtensionRouteStream {
  /** The route's own events: the strict schema of the members of each event, by the event's name (the `event` member itself is added by the core). Never `answer` or `error`. */
  readonly events: Readonly<Record<string, ZodType>>;
  /** The longest a stream stays open, in milliseconds; after that the core ends it with an `error` event and the request's abort signal fires. */
  readonly maxMs: number;
}

export interface ExtensionRoute {
  readonly method: ExtensionRouteMethod;
  readonly url: string;
  readonly permission: ExtensionRoutePermission;
  /** The strict schema of the path parameters; a value that does not fit is `INVALID_REQUEST` and the handler does not run. */
  readonly params?: ZodType;
  /** The strict schema of the query string; a value that does not fit is `INVALID_REQUEST` and the handler does not run. */
  readonly query?: ZodType;
  /** A route about one investigation of the caller: the path parameter that names it and the code a miss is answered with, before the handler runs. The request then carries `investigation` with the source of the record. */
  readonly investigation?: { readonly param: string; readonly missing: 'NOT_FOUND' | 'ACCESS_DENIED' };
  /** Required for a `POST` route and refused on a `GET` route: the strict schema of the body. */
  readonly requestSchema?: ZodType;
  readonly responseSchema: ZodType;
  /** A route that may send events before its answer to a client that asked for a stream. Never together with `idempotent`: the application refuses to start. */
  readonly stream?: ExtensionRouteStream;
  /** False when the feature of the route is switched off: the application then reads nothing of the request, as with the switch off, and the handler gives the refusal. Absent, the route is live. */
  readonly active?: () => boolean;
  /** A route a retry could repeat: the application requires an `Idempotency-Key`, runs the handler once per person and key, and replays its answer; `sourceOf` names the source the request is about. */
  readonly idempotent?: {
    readonly sourceOf: (body: unknown) => string;
    /** Asked before a stored answer is replayed, with the request as it is now: false refuses the replay as a lost access, so a replay is authorized like a new call. */
    readonly recheck?: (request: ExtensionRequest) => Promise<boolean>;
    /** True for an answer that must not be kept, such as the failure of a provider: a retry with the key runs again. */
    readonly retryable?: (answer: unknown) => boolean;
  };
  readonly handler: (request: ExtensionRequest) => Promise<unknown>;
}

export interface ExtensionRouteGroup {
  readonly routes: readonly ExtensionRoute[];
}

/** The budgets of a source that a file of the extension can be checked against at start-up. */
export interface ConfigureSourceBudgets {
  readonly maxHops: number;
  readonly pathResultsCap: number;
  readonly maxPage: number;
}

/** What the application tells the extension when it configures it: the ids of the sources of the mapping file and, for each, the budgets its files are checked against. */
export interface ConfigureContext {
  readonly sourceIds: readonly string[];
  /** Which AI features are on, as the application decided from the environment; absent, all are on. */
  readonly features?: { readonly ask: boolean; readonly summary: boolean; readonly assistant: boolean };
  readonly budgets?: Readonly<Record<string, ConfigureSourceBudgets>>;
  /** The types of each source with the description the mapping gives each, so that the extension can say at start-up which descriptions it will not use. */
  readonly typeDescriptions?: Readonly<Record<string, TypeDescriptions>>;
}

export interface ConfigureWarning {
  readonly event: string;
  readonly message: string;
}

export type ConfigureOutcome = { readonly ok: true; readonly warnings?: readonly ConfigureWarning[] } | { readonly ok: false; readonly problems: readonly string[] };

/** The one method of the API's logger an extension may use. */
export interface ExtensionLogger {
  readonly warn: (fields: Readonly<Record<string, unknown>>, message: string) => void;
  /** Says what a task did; the application's logger has it, and an extension must not need it. */
  readonly info?: (fields: Readonly<Record<string, unknown>>, message: string) => void;
}

/** One write to a store of the extension. Only its ids are logged when it fails, never what it writes. It is written once or, after a failed try, again, and it can be lost on a stop or a full queue, so it must be safe to write twice. */
export interface RecordJob {
  readonly ids: Readonly<Record<string, string>>;
  write(signal?: AbortSignal): Promise<void>;
}

export interface RecordQueue {
  /** Takes the job and returns at once; it never throws. */
  enqueue(job: RecordJob): void;
}

export interface ProfileExtension {
  readonly name: string;
  readonly routeGroups: readonly ExtensionRouteGroup[];
  readonly migrationsDirectory?: string;
  /** Hands the extension the API's own logger, before `configure` is called. */
  readonly attachLogger?: (logger: ExtensionLogger) => void;
  /** Hands the extension the audit sink of the application's queue, built after the store's sink: the events of the extension's own writers (its model calls, its summary) go through it and never wait for the store. Absent, they go to the mounted sink. */
  readonly attachAudit?: (sink: AuditSink) => void;
  /** Hands the extension the queue its stored run records are written through: a record is queued and written after the call that made it has gone on, so no call waits for its record. Absent, the extension writes its records itself. */
  readonly attachRecordQueue?: (queue: RecordQueue) => void;
  /** The classifier of the extension, once it can classify (the model is configured, the audit sink is mounted and the folder is loaded); a classifier given to the application through its seams wins over it, and the Community default is used when there is none. */
  readonly askClassifier?: () => AskClassifier | undefined;
  /** The summarizer of the extension, once it can draft; a summarizer given to the application through its seams wins over it, and the Community default is used when there is none. */
  readonly caseSummarizer?: () => CaseSummarizer | undefined;
  /** The Ask folder as it was read at start-up: undefined before `configure` has run or when it refused. */
  readonly askFolder?: () => AskFolder | undefined;
  readonly configure?: (settings: AiSettings, env: Readonly<Record<string, string | undefined>>, context: ConfigureContext) => Promise<ConfigureOutcome>;
  /** The audit sink that replaces the Community one, which keeps nothing; given the application's own database login and its limits. */
  readonly createAuditSink?: (context: AuditSinkContext) => MountedAuditSink;
  /** Which AI features can be used now, as `GET /v1/ai/status` says; absent, none can. */
  readonly aiAvailability?: () => AiStatusResponse;
}

const EXTENSION_REFUSAL_NAME = 'ExtensionRefusal';

const named = z.literal(EXTENSION_REFUSAL_NAME);
/** A key a refusal of this code never carries: absent or undefined, so a value of it is not recognised. */
const none = z.undefined().optional();

const aiOffRefusalSchema = z.object({ name: named, code: z.literal('ACCESS_DENIED'), reason: z.literal('ai-off'), audited: z.boolean() });
const notInThisEditionRefusalSchema = z.object({ name: named, code: z.literal('ASK_UNSUPPORTED'), reason: z.literal('not-in-this-edition') });

const notFoundRefusalSchema = z.object({ name: named, code: z.literal('NOT_FOUND') });
const queryTimeoutRefusalSchema = z.object({ name: named, code: z.literal('QUERY_TIMEOUT'), timeoutMs: z.number().int().positive() });
const auditUnavailableRefusalSchema = z.object({ name: named, code: z.literal('AUDIT_UNAVAILABLE') });
const invalidRequestRefusalSchema = z.object({ name: named, code: z.literal('INVALID_REQUEST'), reason: z.string().min(1) });
/** The refusals of the gate's reads and of a run, which carry no more than their code, or the figures the error model allows for it. */
const accessDeniedRefusalSchema = z.object({ name: named, code: z.literal('ACCESS_DENIED'), reason: none, audited: none });
const sourceMismatchRefusalSchema = z.object({ name: named, code: z.literal('SOURCE_MISMATCH'), reason: none });
const sourceBusyRefusalSchema = z.object({ name: named, code: z.literal('SOURCE_BUSY'), reason: none });
const askIntentInvalidRefusalSchema = z.object({ name: named, code: z.literal('ASK_INTENT_INVALID'), reason: none });
const budgetRefusalSchema = z.object({ name: named, code: z.literal('QUERY_BUDGET_EXCEEDED'), reason: none, maxPage: z.number().int().positive().optional(), maxHops: z.number().int().positive().optional(), pathResultsCap: z.number().int().positive().optional() });
const rateLimitedRefusalSchema = z.object({ name: named, code: z.literal('RATE_LIMITED'), reason: none, retryAfterMs: z.number().int().nonnegative().optional() });
const sourceUnavailableRefusalSchema = z
  .object({ name: named, code: z.literal('SOURCE_UNAVAILABLE'), reason: z.enum(SOURCE_UNAVAILABLE_REASONS), retryAfterMs: z.number().int().nonnegative().optional() })
  .refine((fields) => fields.retryAfterMs === undefined || fields.reason === 'repeated-timeouts', { message: 'only repeated-timeouts has a wait' });
/** A refusal of a run names a reason about the saved pattern it names, no other reason of `CONFLICT`. */
const PATTERN_CONFLICT_REASONS = ['pattern-changed', 'pattern-unavailable'] as const;
const conflictRefusalSchema = z.object({ name: named, code: z.literal('CONFLICT'), reason: z.enum(PATTERN_CONFLICT_REASONS) });

const refusalSchemas = [
  aiOffRefusalSchema,
  notInThisEditionRefusalSchema,
  notFoundRefusalSchema,
  invalidRequestRefusalSchema,
  queryTimeoutRefusalSchema,
  auditUnavailableRefusalSchema,
  accessDeniedRefusalSchema,
  sourceMismatchRefusalSchema,
  sourceBusyRefusalSchema,
  askIntentInvalidRefusalSchema,
  budgetRefusalSchema,
  rateLimitedRefusalSchema,
  sourceUnavailableRefusalSchema,
  conflictRefusalSchema,
] as const;

/**
 * What a refusal is made of: the preview being off (with whether the refusal's own audit event was written), Ask not being available in this build, a thing the call names not being there, a request
 * whose parts the route cannot accept (with the reason), a call that ran out of time (with the limit), or one of the gate's refusals of a read or a run's refusals, each with the figures and the
 * reason the error model allows for its code and nothing else.
 */
export const extensionRefusalSchema = z.union(refusalSchemas);

type FieldsOf<T extends z.ZodType> = T extends z.ZodType ? Omit<z.input<T>, 'name'> : never;

export type ExtensionRefusalFields = FieldsOf<(typeof refusalSchemas)[number]>;

/** Thrown by a route handler of an extension to refuse a call; the API answers it with the code and the details it names. */
export class ExtensionRefusal extends Error {
  readonly code: ExtensionRefusalFields['code'];
  readonly reason: string | undefined;
  /** Only a refusal that is audited says whether its event was written. */
  readonly audited: boolean | undefined;
  readonly timeoutMs: number | undefined;
  readonly retryAfterMs: number | undefined;
  readonly maxPage: number | undefined;
  readonly maxHops: number | undefined;
  readonly pathResultsCap: number | undefined;

  constructor(fields: ExtensionRefusalFields) {
    super();
    this.name = EXTENSION_REFUSAL_NAME;
    const held: { code: string; reason?: string; audited?: boolean; timeoutMs?: number; retryAfterMs?: number; maxPage?: number; maxHops?: number; pathResultsCap?: number } = fields;
    this.code = fields.code;
    this.reason = held.reason;
    this.audited = held.audited;
    this.timeoutMs = held.timeoutMs;
    this.retryAfterMs = held.retryAfterMs;
    this.maxPage = held.maxPage;
    this.maxHops = held.maxHops;
    this.pathResultsCap = held.pathResultsCap;
  }
}

/**
 * The refusal a thrown value is, recognised by its shape: the enterprise code carries its own copy of this package in the image, so a class from that copy is not this one. Nothing else about the
 * value is read.
 */
export function parseExtensionRefusal(value: unknown): ExtensionRefusalFields | undefined {
  const parsed = extensionRefusalSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const { name: _name, ...fields } = parsed.data;
  // a key the value holds with no value is left out, so `'audited' in refusal` means the refusal says it
  return Object.fromEntries(Object.entries(fields).filter(([, entry]) => entry !== undefined)) as ExtensionRefusalFields;
}
