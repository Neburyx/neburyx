import { z, type ZodType } from 'zod';
import type { AiSettings } from './ai.js';
import type { ASK_PLAN_TEMPLATE_IDS, SAVED_PATTERN_TEMPLATE_ID, AskPatternListing, AskPatternOffer, AskPlanner, AskRunResult } from './ask.js';
import { SOURCE_UNAVAILABLE_REASONS } from './error-codes.js';
import type { AuditEvent, AuditSink, AuditSinkContext, MountedAuditSink } from './audit.js';

export type ExtensionRoutePermission = 'public' | 'principal';

export interface ExtensionRequest {
  readonly principalId: string;
  readonly principalRole: Exclude<AuditEvent['actorRole'], 'system'>;
  /** Whether the preview switch is on for this process, as decided at start-up; a route group that is not on refuses its calls. */
  readonly previewOn: boolean;
  readonly traceId: string;
  /** The application's audit sink as it is: a failed write rejects, so a call that must fail closed can. */
  readonly audit: AuditSink;
  /** The body of a `POST` route, already parsed by the route's request schema. */
  readonly body?: unknown;
  /** The application's `AskPlanner`: the Community default unless the application was given another. */
  readonly askPlanner: AskPlanner;
  /** Signs a text: 64 lowercase hex characters, with a key that stays in the application. Absent, a route that needs it refuses. */
  readonly signText?: (canonical: string) => string;
  /**
   * The run of a plan of the caller on one source, through the gate: the factory is built for this request (its caller, trace ID and abort signal). The runner it returns reads only the source of the
   * scope, and its reads refuse, as `NOT_FOUND` and before anything is read, a source that is not configured or that the caller may not read; that refusal comes with the run, so a plan that meets it is a failed run.
   */
  readonly askPlanRunner?: (scope: AskRunScope) => AskPlanRunner;
  /** The saved patterns the caller may run on a source, available against the mapping, newest changed first, at most as many as a catalog holds; `NOT_FOUND` for a source the caller may not read. */
  readonly askPatterns?: (sourceId: string) => Promise<AskPatternListing>;
  /** One saved pattern the caller may run on a source, found by its id whatever the size of the listing: the same offer `askPatterns` would give, or undefined when it is not one the caller may run now. */
  readonly askPatternFind?: (sourceId: string, id: string) => Promise<AskPatternOffer | undefined>;
}

/** The source a plan is run on and whether the personal data of the nodes of its result is masked. */
export interface AskRunScope {
  readonly sourceId: string;
  readonly mask: boolean;
}

/** What a run of a plan came to: the result, or the refusal of the gate with the code and details the manual route gives, never a partial result. */
export type AskPlanRun = { readonly status: 'ok'; readonly result: AskRunResult } | { readonly status: 'refused'; readonly refusal: ExtensionRefusalFields };

export interface AskPlanRunner {
  /** Runs a template with the parameters a stored plan holds, as the service of its manual route would; `continue` is set only by a verified token and lets a heavy run read its bounded page. */
  run(plan: { readonly templateId: (typeof ASK_PLAN_TEMPLATE_IDS)[number] | typeof SAVED_PATTERN_TEMPLATE_ID; readonly params: unknown }, options?: { readonly continue?: boolean }): Promise<AskPlanRun>;
}

export type ExtensionRouteMethod = 'GET' | 'POST';

export interface ExtensionRoute {
  readonly method: ExtensionRouteMethod;
  readonly url: string;
  readonly permission: ExtensionRoutePermission;
  /** Required for a `POST` route and refused on a `GET` route: the strict schema of the body. */
  readonly requestSchema?: ZodType;
  readonly responseSchema: ZodType;
  readonly handler: (request: ExtensionRequest) => Promise<unknown>;
}

export interface ExtensionRouteGroup {
  readonly routes: readonly ExtensionRoute[];
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

export interface ProfileExtension {
  readonly name: string;
  readonly routeGroups: readonly ExtensionRouteGroup[];
  readonly migrationsDirectory?: string;
  /** Hands the extension the API's own logger, before `configure` is called. */
  readonly attachLogger?: (logger: ExtensionLogger) => void;
  /** The planner of the extension, once it can plan (the model is configured and the audit sink is mounted); a planner given to the application through its seams wins over it, and the Community default is used when there is none. */
  readonly askPlanner?: () => AskPlanner | undefined;
  readonly configure?: (settings: AiSettings, env: Readonly<Record<string, string | undefined>>) => Promise<ConfigureOutcome>;
  /** The audit sink that replaces the Community one, which keeps nothing; given the application's own database login and its limits. */
  readonly createAuditSink?: (context: AuditSinkContext) => MountedAuditSink;
}

const EXTENSION_REFUSAL_NAME = 'ExtensionRefusal';

const named = z.literal(EXTENSION_REFUSAL_NAME);
/** A key a refusal of this code never carries: absent or undefined, so a value of it is not recognised. */
const none = z.undefined().optional();

const previewOffRefusalSchema = z.object({ name: named, code: z.literal('ACCESS_DENIED'), reason: z.literal('ai-preview-off'), audited: z.boolean() });
const notInThisEditionRefusalSchema = z.object({ name: named, code: z.literal('ASK_UNSUPPORTED'), reason: z.literal('not-in-this-edition') });

const notFoundRefusalSchema = z.object({ name: named, code: z.literal('NOT_FOUND') });
const queryTimeoutRefusalSchema = z.object({ name: named, code: z.literal('QUERY_TIMEOUT'), timeoutMs: z.number().int().positive() });
const auditUnavailableRefusalSchema = z.object({ name: named, code: z.literal('AUDIT_UNAVAILABLE') });
const invalidRequestRefusalSchema = z.object({ name: named, code: z.literal('INVALID_REQUEST'), reason: z.string().min(1) });
/** The refusals of the gate's reads and of a plan, which carry no more than their code, or the figures the error model allows for it. */
const accessDeniedRefusalSchema = z.object({ name: named, code: z.literal('ACCESS_DENIED'), reason: none, audited: none });
const sourceMismatchRefusalSchema = z.object({ name: named, code: z.literal('SOURCE_MISMATCH'), reason: none });
const sourceBusyRefusalSchema = z.object({ name: named, code: z.literal('SOURCE_BUSY'), reason: none });
const askPlanInvalidRefusalSchema = z.object({ name: named, code: z.literal('ASK_PLAN_INVALID'), reason: none });
const budgetRefusalSchema = z.object({ name: named, code: z.literal('QUERY_BUDGET_EXCEEDED'), reason: none, maxPage: z.number().int().positive().optional(), maxHops: z.number().int().positive().optional() });
const rateLimitedRefusalSchema = z.object({ name: named, code: z.literal('RATE_LIMITED'), reason: none, retryAfterMs: z.number().int().nonnegative().optional() });
const sourceUnavailableRefusalSchema = z
  .object({ name: named, code: z.literal('SOURCE_UNAVAILABLE'), reason: z.enum(SOURCE_UNAVAILABLE_REASONS), retryAfterMs: z.number().int().nonnegative().optional() })
  .refine((fields) => fields.retryAfterMs === undefined || fields.reason === 'repeated-timeouts', { message: 'only repeated-timeouts has a wait' });
/** A refusal of a run names a reason about the saved pattern it names, no other reason of `CONFLICT`. */
const PLAN_CONFLICT_REASONS = ['pattern-changed', 'pattern-unavailable'] as const;
const conflictRefusalSchema = z.object({ name: named, code: z.literal('CONFLICT'), reason: z.enum(PLAN_CONFLICT_REASONS) });

const refusalSchemas = [
  previewOffRefusalSchema,
  notInThisEditionRefusalSchema,
  notFoundRefusalSchema,
  invalidRequestRefusalSchema,
  queryTimeoutRefusalSchema,
  auditUnavailableRefusalSchema,
  accessDeniedRefusalSchema,
  sourceMismatchRefusalSchema,
  sourceBusyRefusalSchema,
  askPlanInvalidRefusalSchema,
  budgetRefusalSchema,
  rateLimitedRefusalSchema,
  sourceUnavailableRefusalSchema,
  conflictRefusalSchema,
] as const;

/**
 * What a refusal is made of: the preview being off (with whether the refusal's own audit event was written), Ask having no planner in this build, a thing the call names not being there, a request
 * whose parts the route cannot accept (with the reason), a call that ran out of time (with the limit), or one of the gate's refusals of a read or a plan's refusals, each with the figures and the
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

  constructor(fields: ExtensionRefusalFields) {
    super();
    this.name = EXTENSION_REFUSAL_NAME;
    const held: { code: string; reason?: string; audited?: boolean; timeoutMs?: number; retryAfterMs?: number; maxPage?: number; maxHops?: number } = fields;
    this.code = fields.code;
    this.reason = held.reason;
    this.audited = held.audited;
    this.timeoutMs = held.timeoutMs;
    this.retryAfterMs = held.retryAfterMs;
    this.maxPage = held.maxPage;
    this.maxHops = held.maxHops;
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
