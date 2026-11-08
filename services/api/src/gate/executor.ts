import type { UnavailableReason } from '../errors.js';
import type { Params, Plan, Row } from './types.js';

export interface ExecuteCall {
  readonly sourceId: string;
  readonly templateId: string;
  readonly templateVersion: string;
  readonly cypher: string;
  readonly parameters: Params;
  readonly integerParameters?: readonly string[];
  /** True for a template that profiles its read; the outcome then carries the plan. */
  readonly profile?: boolean;
  readonly accessMode: 'READ';
  readonly timeoutMs: number;
  readonly rowLimit: number;
  readonly deadlineAt: number;
  readonly traceId: string;
  /** Aborted when the request is cancelled: the adapter closes the read's session at once and ends the read as `cancelled`. */
  readonly signal?: AbortSignal;
  /**
   * Told, no later than the read settles (with an outcome or an error), of a promise that settles when the read's connection is back: its session closed, or the close given up.
   * The gate keeps the read's lease until then. An executor that holds no connection after answering need not call it.
   */
  readonly onClosed?: (closed: Promise<void>) => void;
}

export type ExecuteOutcome =
  | { readonly status: 'rows'; readonly rows: readonly Row[]; readonly plan?: Plan }
  | { readonly status: 'timeout' }
  | { readonly status: 'cancelled' }
  | { readonly status: 'unavailable'; readonly reason: UnavailableReason };

export interface ReadExecutor {
  execute(call: ExecuteCall): Promise<ExecuteOutcome>;
}
