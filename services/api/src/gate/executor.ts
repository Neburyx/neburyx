import type { UnavailableReason } from '../errors.js';
import type { Params, Row } from './types.js';

export interface ExecuteCall {
  readonly sourceId: string;
  readonly templateId: string;
  readonly templateVersion: string;
  readonly cypher: string;
  readonly parameters: Params;
  readonly integerParameters?: readonly string[];
  readonly accessMode: 'READ';
  readonly timeoutMs: number;
  readonly rowLimit: number;
  readonly deadlineAt: number;
  readonly traceId: string;
}

export type ExecuteOutcome =
  | { readonly status: 'rows'; readonly rows: readonly Row[] }
  | { readonly status: 'timeout' }
  | { readonly status: 'unavailable'; readonly reason: UnavailableReason };

export interface ReadExecutor {
  execute(call: ExecuteCall): Promise<ExecuteOutcome>;
}
