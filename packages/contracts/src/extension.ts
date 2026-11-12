import { z, type ZodType } from 'zod';
import type { AiSettings } from './ai.js';
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
}

export interface ExtensionRoute {
  readonly method: 'GET';
  readonly url: string;
  readonly permission: ExtensionRoutePermission;
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

export interface ProfileExtension {
  readonly name: string;
  readonly routeGroups: readonly ExtensionRouteGroup[];
  readonly migrationsDirectory?: string;
  readonly configure?: (settings: AiSettings, env: Readonly<Record<string, string | undefined>>, view?: AiMappingView) => Promise<ConfigureOutcome>;
  /** The audit sink that replaces the Community one, which keeps nothing; given the application's own database login and its limits. */
  readonly createAuditSink?: (context: AuditSinkContext) => MountedAuditSink;
}

const EXTENSION_REFUSAL_NAME = 'ExtensionRefusal';

/** What a refusal is made of: the one code and the one reason a route group may refuse with today, and whether the refusal's own audit event was written. */
export const extensionRefusalSchema = z.object({
  name: z.literal(EXTENSION_REFUSAL_NAME),
  code: z.literal('ACCESS_DENIED'),
  reason: z.literal('ai-preview-off'),
  audited: z.boolean(),
});

export type ExtensionRefusalFields = Omit<z.infer<typeof extensionRefusalSchema>, 'name'>;

/** Thrown by a route handler of an extension to refuse a call; the API answers it with the code and reason it names. */
export class ExtensionRefusal extends Error {
  readonly code: ExtensionRefusalFields['code'];
  readonly reason: ExtensionRefusalFields['reason'];
  readonly audited: boolean;

  constructor(fields: ExtensionRefusalFields) {
    super();
    this.name = EXTENSION_REFUSAL_NAME;
    this.code = fields.code;
    this.reason = fields.reason;
    this.audited = fields.audited;
  }
}

/**
 * The refusal a thrown value is, recognised by its shape: the enterprise code carries its own copy of this package in the image, so a class from that copy is not this one. Nothing else about the
 * value is read.
 */
export function parseExtensionRefusal(value: unknown): ExtensionRefusalFields | undefined {
  const parsed = extensionRefusalSchema.safeParse(value);
  return parsed.success ? { code: parsed.data.code, reason: parsed.data.reason, audited: parsed.data.audited } : undefined;
}
