import type { AuditSinkContext } from '@neburyx/contracts';
import pg from 'pg';

/** The size of the pool the store keeps of its own: a record is a few short statements. */
const RUN_POOL_SIZE = 2;

/** What a failed write says: a fixed message, never the driver's text, the statement or a value. */
export class SummaryRunStoreError extends Error {
  readonly code = 'SUMMARY_RUN_WRITE_FAILED';

  constructor() {
    super('the record of the case summary could not be written');
    this.name = 'SummaryRunStoreError';
  }
}

interface SummaryRunStart {
  readonly actorId: string;
  /** Only an id that is a UUID is kept: the column is one. */
  readonly investigationId?: string;
  readonly sourceId: string;
  readonly traceId: string;
  readonly startedAt: Date;
  readonly settings: Readonly<Record<string, unknown>>;
}

interface SummaryCallStart {
  readonly runId: string;
  readonly number: number;
  readonly startedAt: Date;
  readonly instructionsSha256: string;
  readonly instructionsText: string;
  readonly valuesText: string;
}

type SummaryCallStatus = 'answered' | 'refused' | 'failed' | 'cancelled';

export interface SummaryCallEnd {
  readonly runId: string;
  readonly number: number;
  readonly status: SummaryCallStatus;
  readonly failureKind?: string;
  /** The text the provider returned, where it returned any. */
  readonly replyText?: string;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly durationMs: number;
}

/** The record of what a summary click sent to the model and what came back. Nothing reads it back: it is written, and removed after the retention period. */
export interface SummaryRunStore {
  /** Writes the run row and answers its id. */
  begin(run: SummaryRunStart): Promise<string>;
  beginCall(call: SummaryCallStart): Promise<void>;
  endCall(call: SummaryCallEnd): Promise<void>;
  finish(runId: string, outcome: string, calls: number, finishedAt: Date): Promise<void>;
  /** Removes the runs that started before the moment, with their calls; answers how many. */
  removeStartedBefore(moment: Date): Promise<number>;
  close(): Promise<void>;
}

export interface SummaryPool {
  query(text: string, values: readonly unknown[]): Promise<{ readonly rowCount?: number | null }>;
  end(): Promise<void>;
  on(event: 'error', listener: () => void): unknown;
}

interface Deps {
  readonly createPool: (config: pg.PoolConfig) => SummaryPool;
}

const defaultDeps: Deps = { createPool: (config) => new pg.Pool(config) };

const INSERT_RUN = 'INSERT INTO summary_runs (id, actor_id, investigation_id, source_id, trace_id, started_at, settings) VALUES ($1, $2, $3, $4, $5, $6, $7)';
const INSERT_CALL =
  'INSERT INTO summary_run_calls (run_id, call_number, started_at, instructions_sha256, instructions_text, values_text) VALUES ($1, $2, $3, $4, $5, $6)';
const UPDATE_CALL =
  'UPDATE summary_run_calls SET status = $3, failure_kind = $4, reply_text = $5, tokens_in = $6, tokens_out = $7, duration_ms = $8 WHERE run_id = $1 AND call_number = $2';
const UPDATE_RUN = 'UPDATE summary_runs SET outcome = $2, calls = $3, finished_at = $4 WHERE id = $1';
const DELETE_OLD = 'DELETE FROM summary_runs WHERE started_at < $1';

/** Keeps the records in `summary_runs` and `summary_run_calls` through the application's own database login, on a pool of its own. */
export function createPgSummaryRunStore(context: AuditSinkContext, deps: Deps = defaultDeps): SummaryRunStore {
  const pool = deps.createPool({
    connectionString: context.databaseUrl,
    max: RUN_POOL_SIZE,
    ...(context.connectionStream === undefined ? {} : { stream: context.connectionStream }),
    connectionTimeoutMillis: context.connectionTimeoutMs,
    statement_timeout: context.statementTimeoutMs,
    query_timeout: context.queryTimeoutMs,
  });
  pool.on('error', context.onConnectionError);
  let closing: Promise<void> | undefined;

  async function write(text: string, values: readonly unknown[], rows?: number): Promise<number> {
    let count: number;
    try {
      const result = await pool.query(text, values);
      count = result.rowCount ?? 0;
    } catch {
      // the driver's error can hold the failing row, so only a fixed error leaves the store
      throw new SummaryRunStoreError();
    }
    // an update that found no row is a record that was not written
    if (rows !== undefined && count !== rows) throw new SummaryRunStoreError();
    return count;
  }

  return {
    async begin(run) {
      const id = context.newId();
      await write(INSERT_RUN, [id, run.actorId, run.investigationId ?? null, run.sourceId, run.traceId, run.startedAt, JSON.stringify(run.settings)], 1);
      return id;
    },
    async beginCall(call) {
      await write(INSERT_CALL, [call.runId, call.number, call.startedAt, call.instructionsSha256, call.instructionsText, call.valuesText], 1);
    },
    async endCall(call) {
      await write(UPDATE_CALL, [call.runId, call.number, call.status, call.failureKind ?? null, call.replyText ?? null, call.tokensIn ?? null, call.tokensOut ?? null, call.durationMs], 1);
    },
    async finish(runId, outcome, calls, finishedAt) {
      await write(UPDATE_RUN, [runId, outcome, calls, finishedAt], 1);
    },
    removeStartedBefore: (moment) => write(DELETE_OLD, [moment]),
    close: () => (closing ??= pool.end()),
  };
}

export interface MemorySummaryRun {
  readonly id: string;
  readonly start: SummaryRunStart;
  outcome?: string;
  calls?: number;
  finishedAt?: Date;
  readonly callStarts: SummaryCallStart[];
  readonly callEnds: SummaryCallEnd[];
}

/** Only a test uses this: a store that keeps the records in memory and can be made to fail, so no database is needed. */
export function createMemorySummaryRunStore(options: { readonly failOn?: 'begin' | 'beginCall' | 'endCall' | 'finish' } = {}): SummaryRunStore & { readonly runs: MemorySummaryRun[] } {
  const runs: MemorySummaryRun[] = [];
  const check = (step: 'begin' | 'beginCall' | 'endCall' | 'finish'): void => {
    if (options.failOn === step) throw new SummaryRunStoreError();
  };
  const find = (runId: string): MemorySummaryRun => {
    const run = runs.find((candidate) => candidate.id === runId);
    if (run === undefined) throw new SummaryRunStoreError();
    return run;
  };
  return {
    runs,
    async begin(start) {
      check('begin');
      const id = `00000000-0000-7000-8000-${String(runs.length + 1).padStart(12, '0')}`;
      runs.push({ id, start, callStarts: [], callEnds: [] });
      return id;
    },
    async beginCall(call) {
      check('beginCall');
      find(call.runId).callStarts.push(call);
    },
    async endCall(call) {
      check('endCall');
      const ends = find(call.runId).callEnds;
      const held = ends.findIndex((end) => end.number === call.number);
      if (held < 0) ends.push(call);
      else ends[held] = call;
    },
    async finish(runId, outcome, calls, finishedAt) {
      check('finish');
      Object.assign(find(runId), { outcome, calls, finishedAt });
    },
    async removeStartedBefore(moment) {
      const kept = runs.filter((run) => run.start.startedAt.getTime() >= moment.getTime());
      const removed = runs.length - kept.length;
      runs.splice(0, runs.length, ...kept);
      return removed;
    },
    async close() {},
  };
}
