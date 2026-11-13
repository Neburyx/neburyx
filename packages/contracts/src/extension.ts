import { z, type ZodType } from 'zod';
import type { AiSettings } from './ai.js';
import type { AskPlanner } from './ask.js';
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

export interface AiViewProperty {
  readonly name: string;
  readonly pii: boolean;
}

export interface AiViewType {
  readonly name: string;
  readonly kind: 'entity' | 'relationship';
  readonly properties: readonly AiViewProperty[];
}

/** The entity and relationship types the mapping names, each with the properties it names for the type: what an operator's property list may refer to. */
export interface AiMappingView {
  readonly types: readonly AiViewType[];
}

export interface ConfigureWarning {
  readonly event: string;
  readonly message: string;
}

export type ConfigureOutcome = { readonly ok: true; readonly warnings?: readonly ConfigureWarning[] } | { readonly ok: false; readonly problems: readonly string[] };

/** The one method of the API's logger an extension may use. */
export interface ExtensionLogger {
  readonly warn: (fields: Readonly<Record<string, unknown>>, message: string) => void;
}

export interface ProfileExtension {
  readonly name: string;
  readonly routeGroups: readonly ExtensionRouteGroup[];
  readonly migrationsDirectory?: string;
  /** Hands the extension the API's own logger, before `configure` is called. */
  readonly attachLogger?: (logger: ExtensionLogger) => void;
  readonly configure?: (settings: AiSettings, env: Readonly<Record<string, string | undefined>>, view?: AiMappingView) => Promise<ConfigureOutcome>;
  /** The audit sink that replaces the Community one, which keeps nothing; given the application's own database login and its limits. */
  readonly createAuditSink?: (context: AuditSinkContext) => MountedAuditSink;
}

const EXTENSION_REFUSAL_NAME = 'ExtensionRefusal';

const previewOffRefusalSchema = z.object({ name: z.literal(EXTENSION_REFUSAL_NAME), code: z.literal('ACCESS_DENIED'), reason: z.literal('ai-preview-off'), audited: z.boolean() });
const notInThisEditionRefusalSchema = z.object({ name: z.literal(EXTENSION_REFUSAL_NAME), code: z.literal('ASK_UNSUPPORTED'), reason: z.literal('not-in-this-edition') });

const notFoundRefusalSchema = z.object({ name: z.literal(EXTENSION_REFUSAL_NAME), code: z.literal('NOT_FOUND') });

/** What a refusal is made of: the preview being off (with whether the refusal's own audit event was written), Ask having no planner in this build, or a thing the call names not being there. */
export const extensionRefusalSchema = z.union([previewOffRefusalSchema, notInThisEditionRefusalSchema, notFoundRefusalSchema]);

export type ExtensionRefusalFields = Omit<z.infer<typeof previewOffRefusalSchema>, 'name'> | Omit<z.infer<typeof notInThisEditionRefusalSchema>, 'name'> | Omit<z.infer<typeof notFoundRefusalSchema>, 'name'>;

/** Thrown by a route handler of an extension to refuse a call; the API answers it with the code and reason it names. */
export class ExtensionRefusal extends Error {
  readonly code: ExtensionRefusalFields['code'];
  readonly reason: string | undefined;
  /** Only a refusal that is audited says whether its event was written. */
  readonly audited: boolean | undefined;

  constructor(fields: ExtensionRefusalFields) {
    super();
    this.name = EXTENSION_REFUSAL_NAME;
    this.code = fields.code;
    this.reason = 'reason' in fields ? fields.reason : undefined;
    this.audited = 'audited' in fields ? fields.audited : undefined;
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
  return fields;
}
