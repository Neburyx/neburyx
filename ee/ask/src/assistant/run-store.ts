import type { AuditSinkContext } from '@neburyx/contracts';
import pg from 'pg';

/** The size of the pool the store keeps of its own: a record is a few short statements. */
const RUN_POOL_SIZE = 2;

/** What a failed write says: a fixed message, never the driver's text, the statement or a value. */
export class AssistantRunStoreError extends Error {
  readonly code = 'ASSISTANT_RUN_WRITE_FAILED';

  constructor() {
    super('the record of an assistant turn could not be written');
    this.name = 'AssistantRunStoreError';
  }
}

interface AssistantRunStart {
  /** Made before the first call and kept in memory, so the turn and Cancel know it before any record is written. */
  readonly id: string;
  readonly actorId: string;
  /** Only an id that is a UUID is kept: the column is one. */
  readonly investigationId?: string;
  readonly sourceId: string;
  readonly traceId: string;
  readonly startedAt: Date;
  readonly settings: Readonly<Record<string, unknown>>;
}

interface AssistantCallStart {
  readonly runId: string;
  readonly number: number;
  readonly startedAt: Date;
  readonly instructionsSha256: string;
  readonly instructionsText: string;
  readonly valuesText: string;
  /** The names of the tools the model was bound to for the call, comma-joined and sorted; absent for a call with none. */
  readonly toolsOffered?: string;
}

type AssistantCallStatus = 'answered' | 'refused' | 'failed' | 'cancelled';

interface AssistantCallEnd {
  readonly runId: string;
  readonly number: number;
  readonly status: AssistantCallStatus;
  readonly failureKind?: string;
  /** The class and the code of the error the provider's client threw, as short codes; never its message. */
  readonly errorClass?: string;
  readonly errorCode?: string;
  readonly errorType?: string;
  /** The text the provider returned, where it returned any. */
  readonly replyText?: string;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly durationMs: number;
}

/** The record of what an assistant turn sent to the model and what came back. Nothing reads it back: it is written, and removed after the retention period. */
export interface AssistantRunStore {
  /** Writes the run row with the id it carries; written again, it leaves one row. */
  begin(run: AssistantRunStart): Promise<void>;
  beginCall(call: AssistantCallStart): Promise<void>;
  endCall(call: AssistantCallEnd): Promise<void>;
  finish(runId: string, outcome: string, calls: number, finishedAt: Date): Promise<void>;
  /** Removes the runs that started before the moment, with their calls; answers how many. */
  removeStartedBefore(moment: Date): Promise<number>;
  close(): Promise<void>;
}

export interface AssistantPool {
  query(text: string, values: readonly unknown[]): Promise<{ readonly rowCount?: number | null }>;
  end(): Promise<void>;
  on(event: 'error', listener: () => void): unknown;
}

interface Deps {
  readonly createPool: (config: pg.PoolConfig) => AssistantPool;
}

const defaultDeps: Deps = { createPool: (config) => new pg.Pool(config) };

const INSERT_RUN = 'INSERT INTO assistant_runs (id, actor_id, investigation_id, source_id, trace_id, started_at, settings) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING';
const INSERT_CALL =
  'INSERT INTO assistant_run_calls (run_id, call_number, started_at, instructions_sha256, instructions_text, values_text, tools_offered) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (run_id, call_number) DO NOTHING';
const UPDATE_CALL =
  'UPDATE assistant_run_calls SET status = $3, failure_kind = $4, reply_text = $5, tokens_in = $6, tokens_out = $7, duration_ms = $8, error_class = $9, error_code = $10, error_type = $11 WHERE run_id = $1 AND call_number = $2';
const UPDATE_RUN = 'UPDATE assistant_runs SET outcome = $2, calls = $3, finished_at = $4 WHERE id = $1';
const DELETE_OLD = 'DELETE FROM assistant_runs WHERE started_at < $1';

/** Keeps the records in `assistant_runs` and `assistant_run_calls` through the application's own database login, on a pool of its own. */
export function createPgAssistantRunStore(context: AuditSinkContext, deps: Deps = defaultDeps): AssistantRunStore {
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
      throw new AssistantRunStoreError();
    }
    // an update that found no row is a record that was not written
    if (rows !== undefined && count !== rows) throw new AssistantRunStoreError();
    return count;
  }

  return {
    async begin(run) {
      await write(INSERT_RUN, [run.id, run.actorId, run.investigationId ?? null, run.sourceId, run.traceId, run.startedAt, JSON.stringify(run.settings)]);
    },
    async beginCall(call) {
      await write(INSERT_CALL, [call.runId, call.number, call.startedAt, call.instructionsSha256, call.instructionsText, call.valuesText, call.toolsOffered ?? null]);
    },
    async endCall(call) {
      await write(UPDATE_CALL, [call.runId, call.number, call.status, call.failureKind ?? null, call.replyText ?? null, call.tokensIn ?? null, call.tokensOut ?? null, call.durationMs, call.errorClass ?? null, call.errorCode ?? null, call.errorType ?? null], 1);
    },
    async finish(runId, outcome, calls, finishedAt) {
      await write(UPDATE_RUN, [runId, outcome, calls, finishedAt], 1);
    },
    removeStartedBefore: (moment) => write(DELETE_OLD, [moment]),
    close: () => (closing ??= pool.end()),
  };
}

export interface MemoryAssistantRun {
  readonly id: string;
  readonly start: AssistantRunStart;
  outcome?: string;
  calls?: number;
  finishedAt?: Date;
  readonly callStarts: AssistantCallStart[];
  readonly callEnds: AssistantCallEnd[];
}

/** Only a test uses this: a store that keeps the records in memory and can be made to fail, so no database is needed. */
export function createMemoryAssistantRunStore(options: { readonly failOn?: 'begin' | 'beginCall' | 'endCall' | 'finish' } = {}): AssistantRunStore & { readonly runs: MemoryAssistantRun[] } {
  const runs: MemoryAssistantRun[] = [];
  const check = (step: 'begin' | 'beginCall' | 'endCall' | 'finish'): void => {
    if (options.failOn === step) throw new AssistantRunStoreError();
  };
  const find = (runId: string): MemoryAssistantRun => {
    const run = runs.find((candidate) => candidate.id === runId);
    if (run === undefined) throw new AssistantRunStoreError();
    return run;
  };
  return {
    runs,
    async begin(start) {
      check('begin');
      if (!runs.some((held) => held.id === start.id)) runs.push({ id: start.id, start, callStarts: [], callEnds: [] });
    },
    async beginCall(call) {
      check('beginCall');
      const starts = find(call.runId).callStarts;
      if (!starts.some((held) => held.number === call.number)) starts.push(call);
    },
    async endCall(call) {
      check('endCall');
      const run = find(call.runId);
      if (!run.callStarts.some((held) => held.number === call.number)) throw new AssistantRunStoreError();
      const ends = run.callEnds;
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
