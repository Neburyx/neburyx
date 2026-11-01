import type { ZodType } from 'zod';
import type { Principal, Seams } from '../seams/seams.js';

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

export interface Template {
  readonly id: string;
  readonly version: string;
  readonly auditAction: string;
  readonly cypher: string;
  readonly paramsSchema: ZodType<Params>;
  refsOf(params: Params): readonly ElementRef[];
  normalize(rows: readonly Row[]): readonly Item[];
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
  readonly sourceId: string;
  readonly budgets: Budgets;
  readonly deadlineAt: number;
}

export interface ExecuteCall {
  readonly sourceId: string;
  readonly templateId: string;
  readonly templateVersion: string;
  readonly cypher: string;
  readonly parameters: Params;
  readonly accessMode: 'READ';
  readonly timeoutMs: number;
  readonly rowLimit: number;
  readonly deadlineAt: number;
  readonly traceId: string;
}

export type ExecuteOutcome =
  | { readonly status: 'rows'; readonly rows: readonly Row[] }
  | { readonly status: 'timeout' }
  | { readonly status: 'unavailable' };

export interface ReadExecutor {
  execute(call: ExecuteCall): Promise<ExecuteOutcome>;
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

export interface GateDeps {
  readonly seams: Pick<Seams, 'policy' | 'coordinator' | 'audit'>;
  readonly catalog: TemplateCatalog;
  readonly executor: ReadExecutor;
  readonly budgetsFor: (sourceId: string) => Budgets;
  readonly redact: (items: readonly Item[], context: GateContext) => readonly Item[];
  readonly clock: Clock;
  readonly logger: GateLogger;
  readonly observer?: GateObserver | undefined;
}

export interface Gate {
  run(request: GateRequest): Promise<GatePage>;
}
