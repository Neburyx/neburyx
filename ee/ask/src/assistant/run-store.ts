import type { AuditSinkContext } from '@neburyx/contracts';
import pg from 'pg';
import { READ_EPOCH } from './thread-epoch.js';

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

/** The guard of the text of a call could not be read: the call was written without its text, and the turn it belongs to must not be stored in its thread either. */
export class AssistantRunGuardError extends Error {
  readonly code = 'ASSISTANT_RUN_GUARD_UNREADABLE';

  constructor() {
    super('the guard of an assistant run record could not be read');
    this.name = 'AssistantRunGuardError';
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
  /** The count the turn read from the thread store before it did any work; absent when it could not be read. A call whose count has moved since is written without text, and so is every call of a run that has none. */
  readonly threadEpoch?: number;
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
  /** Told by a store whose writes are queued when the guard of this write could not be read; never written. */
  readonly onGuardLost?: () => void;
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
  /** Told by a store whose writes are queued when the guard of this write could not be read; never written. */
  readonly onGuardLost?: () => void;
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

interface AssistantClient {
  query(text: string, values?: readonly unknown[]): Promise<{ readonly rowCount?: number | null; readonly rows?: readonly Record<string, unknown>[] }>;
  release(): void;
}

export interface AssistantPool {
  query(text: string, values: readonly unknown[]): Promise<{ readonly rowCount?: number | null }>;
  connect(): Promise<AssistantClient>;
  end(): Promise<void>;
  on(event: 'error', listener: () => void): unknown;
}

interface Deps {
  readonly createPool: (config: pg.PoolConfig) => AssistantPool;
}

const defaultDeps: Deps = { createPool: (config) => new pg.Pool(config) };

const INSERT_RUN = 'INSERT INTO assistant_runs (id, actor_id, investigation_id, source_id, trace_id, started_at, settings, thread_epoch) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING';
const READ_RUN_GUARD = 'SELECT actor_id, investigation_id, thread_epoch FROM assistant_runs WHERE id = $1';
const LOCK_FOR_RUN_WRITE = 'SELECT 1 FROM investigations WHERE id = $1 FOR SHARE';
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

  /** Whether the text of a call of this run may be written: the run's count is the thread's count now, read under the lock of the investigation row that a clearing takes first, so a write is wholly before the clearing (and blanked by it) or wholly after (and sees the moved count). */
  async function textMayBeWritten(client: AssistantClient, runId: string): Promise<boolean> {
    const run = (await client.query(READ_RUN_GUARD, [runId])).rows?.[0];
    if (run === undefined) return false;
    if (run['investigation_id'] === null) return true;
    if (run['thread_epoch'] === null) return false;
    if ((await client.query(LOCK_FOR_RUN_WRITE, [run['investigation_id']])).rows?.[0] === undefined) return false;
    const current = (await client.query(READ_EPOCH, [run['investigation_id'], run['actor_id']])).rows?.[0];
    return current !== undefined && Number(current['epoch']) === Number(run['thread_epoch']);
  }

  /** One write of the text of a call: with the text when the guard holds, without it when the count has moved, and without it when the guard cannot be read (the text is suppressed, never written, when the guard cannot be established). */
  async function guarded(runId: string, statement: (withText: boolean) => { readonly text: string; readonly values: readonly unknown[]; readonly rows?: number }): Promise<void> {
    let client: AssistantClient;
    try {
      client = await pool.connect();
    } catch {
      throw new AssistantRunStoreError();
    }
    let established = false;
    try {
      await client.query('BEGIN');
      const withText = await textMayBeWritten(client, runId);
      established = true;
      const made = statement(withText);
      const result = await client.query(made.text, made.values);
      if (made.rows !== undefined && (result.rowCount ?? 0) !== made.rows) throw new AssistantRunStoreError();
      await client.query('COMMIT');
      return;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (established) throw error instanceof AssistantRunStoreError ? error : new AssistantRunStoreError();
    } finally {
      client.release();
    }
    const blank = statement(false);
    await write(blank.text, blank.values, blank.rows);
    throw new AssistantRunGuardError();
  }

  return {
    async begin(run) {
      await write(INSERT_RUN, [run.id, run.actorId, run.investigationId ?? null, run.sourceId, run.traceId, run.startedAt, JSON.stringify(run.settings), run.threadEpoch ?? null]);
    },
    beginCall: (call) => guarded(call.runId, (withText) => ({ text: INSERT_CALL, values: [call.runId, call.number, call.startedAt, call.instructionsSha256, call.instructionsText, withText ? call.valuesText : '', call.toolsOffered ?? null] })),
    endCall: (call) => guarded(call.runId, (withText) => ({ text: UPDATE_CALL, values: [call.runId, call.number, call.status, call.failureKind ?? null, withText ? (call.replyText ?? null) : null, call.tokensIn ?? null, call.tokensOut ?? null, call.durationMs, call.errorClass ?? null, call.errorCode ?? null, call.errorType ?? null], rows: 1 })),
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
export function createMemoryAssistantRunStore(options: { readonly failOn?: 'begin' | 'beginCall' | 'endCall' | 'finish' | 'guard'; /** The count of the thread store now, as the guard of the real store reads it; with none the text is always written. */ readonly epochOf?: (investigationId: string, actorId: string) => number | undefined } = {}): AssistantRunStore & { readonly runs: MemoryAssistantRun[]; /** What clearing a person's thread does to the call text of their runs of the investigation. */ blankText(investigationId: string, actorId: string): void } {
  const runs: MemoryAssistantRun[] = [];
  const check = (step: 'begin' | 'beginCall' | 'endCall' | 'finish' | 'guard'): void => {
    if (options.failOn === step) throw new AssistantRunStoreError();
  };
  /** A guard that cannot be read writes the call without its text and then says so, as the real store does. */
  const textAllowed = (run: MemoryAssistantRun): boolean => {
    const { investigationId, actorId, threadEpoch } = run.start;
    if (options.failOn === 'guard') return false;
    if (options.epochOf === undefined || investigationId === undefined) return true;
    return threadEpoch !== undefined && options.epochOf(investigationId, actorId) === threadEpoch;
  };
  const find = (runId: string): MemoryAssistantRun => {
    const run = runs.find((candidate) => candidate.id === runId);
    if (run === undefined) throw new AssistantRunStoreError();
    return run;
  };
  return {
    runs,
    blankText(investigationId, actorId) {
      for (const run of runs) {
        if (run.start.actorId !== actorId || run.start.investigationId !== investigationId) continue;
        run.callStarts.splice(0, run.callStarts.length, ...run.callStarts.map((call) => ({ ...call, valuesText: '' })));
        run.callEnds.splice(0, run.callEnds.length, ...run.callEnds.map(({ replyText: _text, ...rest }) => rest));
      }
    },
    async begin(start) {
      check('begin');
      if (!runs.some((held) => held.id === start.id)) runs.push({ id: start.id, start, callStarts: [], callEnds: [] });
    },
    async beginCall({ onGuardLost: _told, ...call }) {
      check('beginCall');
      const run = find(call.runId);
      const starts = run.callStarts;
      if (!starts.some((held) => held.number === call.number)) starts.push(textAllowed(run) ? call : { ...call, valuesText: '' });
      if (options.failOn === 'guard') throw new AssistantRunGuardError();
    },
    async endCall({ onGuardLost: _told, ...call }) {
      check('endCall');
      const run = find(call.runId);
      if (!run.callStarts.some((held) => held.number === call.number)) throw new AssistantRunStoreError();
      const ends = run.callEnds;
      const held = ends.findIndex((end) => end.number === call.number);
      const kept = textAllowed(run) ? call : (({ replyText: _text, ...rest }) => rest)(call);
      if (held < 0) ends.push(kept);
      else ends[held] = kept;
      if (options.failOn === 'guard') throw new AssistantRunGuardError();
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
