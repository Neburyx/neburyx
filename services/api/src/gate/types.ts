import type { ZodType } from 'zod';
import type { Principal } from '../seams/seams.js';

export const GATE_STAGES = ['resolve', 'validate', 'authorize', 'execute', 'normalize', 'redact', 'audit'] as const;
export type GateStage = (typeof GATE_STAGES)[number];

export interface ElementRef {
  readonly sourceId: string;
  readonly entityType: string;
  readonly stableId: string;
}

export type Params = Readonly<Record<string, unknown>>;
export type Row = Readonly<Record<string, unknown>>;
export type Item = Readonly<Record<string, unknown>>;

export type TemplateScope = 'system' | 'user';

/** The parameters the gate fills in from the source's allowlist; a request cannot give them. */
export const GATE_PARAMETERS = ['mappedLabels', 'mappedTypes', 'mappedProperties'] as const;
export type GateParameter = (typeof GATE_PARAMETERS)[number];

export interface Template {
  readonly id: string;
  readonly version: string;
  readonly auditAction: string;
  readonly cypher: string;
  readonly paramsSchema: ZodType<Params>;
  readonly scope: TemplateScope;
  readonly paged: boolean;
  readonly entityParams: readonly string[];
  readonly relationshipParams: readonly string[];
  readonly integerParameters: readonly string[];
  /** The parameters of this template that the gate fills in (the Cypher uses each, and the parameter schema has none of them). */
  readonly gateParameters?: readonly GateParameter[];
  /** False for a template whose runs through the system runner write no audit event (the scheduled ping); absent means they do. */
  readonly auditSystemRuns?: boolean;
  refsOf(params: Params): readonly ElementRef[];
  normalize(rows: readonly Row[]): readonly Item[];
}

export interface SourceAllowlist {
  readonly entityLabels: ReadonlyMap<string, string>;
  readonly relationshipTypes: ReadonlySet<string>;
  /** The `stable_id` property of each entity type, by type. */
  readonly stableIds: ReadonlyMap<string, string>;
  /** Every property name the mapping names: search, reference, evidence, sort and stable id properties. */
  readonly properties: ReadonlySet<string>;
}

export interface TemplateCatalog {
  find(templateId: string): Template | undefined;
  isEnabled(templateId: string, sourceId: string): boolean;
}

export interface Budgets {
  readonly timeoutMs: number;
  readonly maxPage: number;
  readonly requestTimeoutMs: number;
}

export interface GateRequest {
  readonly traceId: string;
  readonly principal: Principal;
  readonly sourceId: string;
  readonly templateId: string;
  readonly params: unknown;
  readonly limit: number;
}

export interface GateContext {
  readonly traceId: string;
  readonly principal: Principal;
  readonly system: boolean;
  readonly sourceId: string;
  readonly budgets: Budgets;
  readonly allowlist: SourceAllowlist;
  readonly deadlineAt: number;
}

export interface GatePage {
  readonly items: readonly Item[];
  readonly hasMore: boolean;
}

export interface GateObserver {
  stage(stage: GateStage, outcome: 'ok' | 'failed'): void;
}

export interface GateLogger {
  warn(fields: object, message: string): void;
}

export type Clock = () => number;

export interface Gate {
  run(request: GateRequest): Promise<GatePage>;
}

export interface SystemRequest {
  readonly traceId: string;
  readonly sourceId: string;
  readonly templateId: string;
  readonly params: unknown;
  readonly limit: number;
}

export interface SystemRunner {
  run(request: SystemRequest): Promise<GatePage>;
}
