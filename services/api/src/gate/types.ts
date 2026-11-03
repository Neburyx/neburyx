import type { ElementRef } from '@neburyx/contracts';
import type { ZodType } from 'zod';
import type { CursorPosition } from './cursor/codec.js';
import type { NormalizeContext, NormalizeModel } from './normalize/model.js';
import type { Principal } from '../seams/seams.js';

export const GATE_STAGES = ['resolve', 'validate', 'authorize', 'execute', 'normalize', 'redact', 'audit'] as const;
export type GateStage = (typeof GATE_STAGES)[number];

export type { ElementRef };

export type Params = Readonly<Record<string, unknown>>;
export type Row = Readonly<Record<string, unknown>>;
export type Item = Readonly<Record<string, unknown>>;

export type TemplateScope = 'system' | 'user';

/** One operator of the plan that a profiled read returns: its name, the server's description of it and the db hits it made. */
export interface PlanOperator {
  readonly name: string;
  readonly details: string | null;
  readonly dbHits: number;
}

/** The plan of a profiled read: null when the read did not complete, the server sent no profile, or the plan is too large to keep. */
export type Plan = readonly PlanOperator[] | null;

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
  /** True for a template whose Cypher starts with `PROFILE `: the executor returns the plan of the read and `normalize` gets it. */
  readonly profile?: boolean;
  /** What a cursor of this template binds besides the source, the person, the template and its parameters: the order of its pages; empty when it has none. */
  readonly sort?: string;
  /** Where the page after this one starts, from the rows of this page; the gate signs it into the page's `nextCursor`. Only a paged template has one. */
  nextPosition?(rows: readonly Row[], limit: number): CursorPosition | undefined;
  refsOf(params: Params): readonly ElementRef[];
  normalize(rows: readonly Row[], plan?: Plan, context?: NormalizeContext): readonly Item[];
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
  /** The `nextCursor` of an earlier page of the same read; only a paged template takes one. */
  readonly cursor?: string;
}

export interface GateContext {
  readonly traceId: string;
  readonly principal: Principal;
  readonly system: boolean;
  readonly sourceId: string;
  readonly budgets: Budgets;
  readonly allowlist: SourceAllowlist;
  /** The version of the policy this request is judged under; a cursor is bound to it. */
  readonly policyVersion: string;
  /** What the normalize stage needs of the source's mapping. */
  readonly model: NormalizeModel;
  readonly deadlineAt: number;
}

export interface GatePage {
  readonly items: readonly Item[];
  readonly hasMore: boolean;
  /** Signed for this request; present only when the read found more than the page and the template says where the next one starts. */
  readonly nextCursor?: string;
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
