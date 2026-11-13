import type { AuditSinkContext } from '@neburyx/contracts';
import pg from 'pg';

/** How long a plan stays runnable after it is stored, counted on the database clock. */
export const PLAN_LIFETIME_MINUTES = 15;
/** The size of the pool the store keeps of its own: a plan call is a handful of short statements. */
export const PLAN_POOL_SIZE = 2;

/** The most plans one sweep clears, so a long gap does not make one statement lock thousands of rows. */
export const PLAN_SWEEP_BATCH = 500;
/** How often the sweep runs: every five minutes, on minutes the other maintenance tasks (03:17, 03:29 and 03:41) do not use. */
export const PLAN_SWEEP_SCHEDULE = '*/5 * * * *';
export const PLAN_SWEEP_TASK = 'ask-sweep-plans';

export const PLAN_STATES = ['proposed', 'confirmed', 'run', 'cancelled', 'expired'] as const;
export type PlanState = (typeof PLAN_STATES)[number];

export type PlanStoreErrorCode = 'PLAN_STORE_FAILED';

/** What a failed store call says: a fixed code and message, never the driver's text, a statement or a value. */
export class PlanStoreError extends Error {
  readonly code: PlanStoreErrorCode = 'PLAN_STORE_FAILED';

  constructor() {
    super('the plan store could not complete the call');
    this.name = 'PlanStoreError';
  }
}

/** A plan as the store holds it: ids, the template and its parameters, and the state; no text of any question. */
export interface StoredPlan {
  readonly id: string;
  readonly userId: string;
  readonly sourceId: string;
  readonly turnId: string | undefined;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly params: unknown;
  readonly state: PlanState;
  readonly parentPlanId: string | undefined;
  readonly planningTraceId: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface NewPlan {
  readonly userId: string;
  readonly sourceId: string;
  readonly turnId?: string;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly params: unknown;
  readonly planningTraceId: string;
}

/** What a plan of the caller turned out not to be when a call could not act on it: not theirs or not there, past its time, or in a state the call does not take. */
export type PlanRefusal = 'absent' | 'expired' | 'not-runnable';

export type ClaimResult = { readonly status: 'claimed'; readonly plan: StoredPlan } | { readonly status: PlanRefusal };
export type CancelResult = { readonly status: 'cancelled' } | { readonly status: PlanRefusal };
export type EditResult = { readonly status: 'edited'; readonly plan: StoredPlan } | { readonly status: PlanRefusal };
export type FinishResult = { readonly status: 'finished'; readonly runId: string } | { readonly status: 'not-runnable' };

export const RUN_OUTCOMES = ['complete', 'partial', 'failed'] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

export interface Edit {
  readonly planId: string;
  readonly userId: string;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly params: unknown;
}

export interface Finish {
  readonly planId: string;
  readonly userId: string;
  readonly outcome: RunOutcome;
  readonly rowCount: number;
  readonly elapsedMs: number;
}

export interface PlanStore {
  /** Stores a plan as `proposed`, to expire 15 minutes after the database clock. */
  insert(plan: NewPlan): Promise<StoredPlan>;
  /** Reads a plan of the caller, whatever its state; a plan that is not there or is another user's is undefined. */
  get(planId: string, userId: string): Promise<StoredPlan | undefined>;
  /** Moves a plan of the caller from `proposed` to `confirmed` in one statement, for one run. */
  claim(planId: string, userId: string): Promise<ClaimResult>;
  /** Moves a `proposed` plan of the caller to `cancelled`. */
  cancel(planId: string, userId: string): Promise<CancelResult>;
  /** Stores an edited plan with the old one as its parent and cancels the old one, together or not at all. */
  edit(edit: Edit): Promise<EditResult>;
  /** Makes a claimed plan `run` and writes its run row, together or not at all. */
  finish(finish: Finish): Promise<FinishResult>;
  /** Marks `proposed` plans that expired unread as `expired` and removes their typed value, at most `limit` of them; says how many it cleared. */
  sweep(limit: number): Promise<number>;
  /** Ends the store's connections; a second call does nothing. */
  close(): Promise<void>;
}

export interface PlanQueryResult {
  readonly rows: readonly Record<string, unknown>[];
  readonly rowCount: number | null;
}

export interface PlanClient {
  query(text: string, values?: readonly unknown[]): Promise<PlanQueryResult>;
  release(): void;
}

/** The part of a connection pool the store uses, so a test can stand in for it. */
export interface PlanPool {
  query(text: string, values?: readonly unknown[]): Promise<PlanQueryResult>;
  connect(): Promise<PlanClient>;
  end(): Promise<void>;
  on(event: 'error', listener: () => void): unknown;
}

export interface PlanStoreDeps {
  readonly createPool: (config: pg.PoolConfig) => PlanPool;
}

const defaultDeps: PlanStoreDeps = { createPool: (config) => new pg.Pool(config) as unknown as PlanPool };

const COLUMNS = 'id, user_id, source_id, turn_id, template_id, template_version, params, state, parent_plan_id, planning_trace_id, created_at, expires_at';

const INSERT = `INSERT INTO ask_plans (id, user_id, source_id, turn_id, template_id, template_version, params, state, parent_plan_id, planning_trace_id, expires_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'proposed', $8, $9, clock_timestamp() + interval '${PLAN_LIFETIME_MINUTES} minutes')
  RETURNING ${COLUMNS}`;

const GET = `SELECT ${COLUMNS} FROM ask_plans WHERE id = $1 AND user_id = $2`;

/**
 * The parameters of a plan once it can no longer run: the typed text of a search is removed, which is the one value a plan holds that the investigator typed. Every statement that moves a plan out of
 * `proposed` sets `params` to this in the same statement, so no state of the row beyond the life of a plan that can still run holds a typed value.
 */
const SCRUBBED = "CASE WHEN template_id = 'search' THEN params - 'text' ELSE params END";

/** The claim is one statement: the target is locked and read, its state is moved and its parameters scrubbed, and the parameters it had are what the claim returns for the run. */
const CLAIM = `WITH target AS (
    SELECT id, params FROM ask_plans
    WHERE id = $1 AND user_id = $2 AND state = 'proposed' AND expires_at > clock_timestamp()
    FOR UPDATE
  )
  UPDATE ask_plans AS plan SET state = 'confirmed', params = CASE WHEN plan.template_id = 'search' THEN plan.params - 'text' ELSE plan.params END
  FROM target WHERE plan.id = target.id
  RETURNING plan.id, plan.user_id, plan.source_id, plan.turn_id, plan.template_id, plan.template_version, target.params AS params, plan.state, plan.parent_plan_id, plan.planning_trace_id, plan.created_at, plan.expires_at`;

const CANCEL = `UPDATE ask_plans SET state = 'cancelled', params = ${SCRUBBED}
  WHERE id = $1 AND user_id = $2 AND state = 'proposed' AND expires_at > clock_timestamp()
  RETURNING id`;

const EDIT_CANCEL = `UPDATE ask_plans SET state = 'cancelled', params = ${SCRUBBED}
  WHERE id = $1 AND user_id = $2 AND state = 'proposed' AND expires_at > clock_timestamp()
  RETURNING source_id, turn_id, planning_trace_id`;

const FINISH_PLAN = `UPDATE ask_plans SET state = 'run' WHERE id = $1 AND user_id = $2 AND state = 'confirmed' RETURNING id`;
const FINISH_RUN = 'INSERT INTO ask_runs (id, plan_id, actor_id, outcome, row_count, elapsed_ms) VALUES ($1, $2, $3, $4, $5, $6)';

/** Marks the plans that expired unread, at most a batch at a time and oldest first, and scrubs them; a plan another call holds is left to that call. */
const SWEEP = `UPDATE ask_plans SET state = 'expired', params = ${SCRUBBED}
  WHERE id IN (SELECT id FROM ask_plans WHERE state = 'proposed' AND expires_at <= clock_timestamp() ORDER BY expires_at LIMIT $1 FOR UPDATE SKIP LOCKED)
  RETURNING id`;

const LOOK = 'SELECT state, expires_at <= clock_timestamp() AS past FROM ask_plans WHERE id = $1 AND user_id = $2';
const EXPIRE = `UPDATE ask_plans SET state = 'expired', params = ${SCRUBBED} WHERE id = $1 AND user_id = $2 AND state = 'proposed' AND expires_at <= clock_timestamp()`;

function plan(row: Record<string, unknown> | undefined): StoredPlan {
  if (row === undefined) throw new PlanStoreError();
  return {
    id: String(row['id']),
    userId: String(row['user_id']),
    sourceId: String(row['source_id']),
    turnId: row['turn_id'] === null || row['turn_id'] === undefined ? undefined : String(row['turn_id']),
    templateId: String(row['template_id']),
    templateVersion: Number(row['template_version']),
    params: row['params'],
    state: row['state'] as PlanState,
    parentPlanId: row['parent_plan_id'] === null || row['parent_plan_id'] === undefined ? undefined : String(row['parent_plan_id']),
    planningTraceId: String(row['planning_trace_id']),
    createdAt: row['created_at'] as Date,
    expiresAt: row['expires_at'] as Date,
  };
}

/** Keeps plans in `ask_plans` through a pool of its own on the application's database login; it reads no source and logs nothing. */
export function createPlanStore(context: AuditSinkContext, deps: PlanStoreDeps = defaultDeps): PlanStore {
  const pool = deps.createPool({
    connectionString: context.databaseUrl,
    max: PLAN_POOL_SIZE,
    ...(context.connectionStream === undefined ? {} : { stream: context.connectionStream }),
    connectionTimeoutMillis: context.connectionTimeoutMs,
    statement_timeout: context.statementTimeoutMs,
    query_timeout: context.queryTimeoutMs,
  });
  pool.on('error', context.onConnectionError);
  let closing: Promise<void> | undefined;

  /** Why a plan could not be acted on: the one place the answer of every call that finds no plan to move comes from. */
  async function refusalOf(runner: Pick<PlanPool, 'query'>, planId: string, userId: string): Promise<PlanRefusal> {
    const [row] = (await runner.query(LOOK, [planId, userId])).rows;
    if (row === undefined) return 'absent';
    if (row['state'] === 'expired') return 'expired';
    if (row['state'] === 'proposed' && row['past'] === true) {
      await runner.query(EXPIRE, [planId, userId]);
      return 'expired';
    }
    return 'not-runnable';
  }

  /** Runs the work in one transaction on one connection: a commit when it returns, a rollback when it throws. */
  async function inTransaction<T>(work: (client: PlanClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async function guarded<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch {
      // the driver's error can hold a row or a statement, so only a fixed code leaves the store
      throw new PlanStoreError();
    }
  }

  const insertValues = (id: string, fields: NewPlan, parent: string | null): readonly unknown[] => [
    id,
    fields.userId,
    fields.sourceId,
    fields.turnId ?? null,
    fields.templateId,
    fields.templateVersion,
    JSON.stringify(fields.params),
    parent,
    fields.planningTraceId,
  ];

  return {
    insert: (fields) => guarded(async () => plan((await pool.query(INSERT, insertValues(context.newId(), fields, null))).rows[0])),

    get: (planId, userId) =>
      guarded(async () => {
        const [row] = (await pool.query(GET, [planId, userId])).rows;
        return row === undefined ? undefined : plan(row);
      }),

    claim: (planId, userId) =>
      guarded(async (): Promise<ClaimResult> => {
        const [row] = (await pool.query(CLAIM, [planId, userId])).rows;
        if (row !== undefined) return { status: 'claimed', plan: plan(row) };
        return { status: await refusalOf(pool, planId, userId) };
      }),

    cancel: (planId, userId) =>
      guarded(async (): Promise<CancelResult> => {
        const [row] = (await pool.query(CANCEL, [planId, userId])).rows;
        if (row !== undefined) return { status: 'cancelled' };
        return { status: await refusalOf(pool, planId, userId) };
      }),

    edit: (edit) =>
      guarded(async (): Promise<EditResult> => {
        const edited = await inTransaction(async (client): Promise<StoredPlan | undefined> => {
          const [old] = (await client.query(EDIT_CANCEL, [edit.planId, edit.userId])).rows;
          if (old === undefined) return undefined;
          const fields: NewPlan = {
            userId: edit.userId,
            sourceId: String(old['source_id']),
            ...(old['turn_id'] === null || old['turn_id'] === undefined ? {} : { turnId: String(old['turn_id']) }),
            templateId: edit.templateId,
            templateVersion: edit.templateVersion,
            params: edit.params,
            planningTraceId: String(old['planning_trace_id']),
          };
          return plan((await client.query(INSERT, insertValues(context.newId(), fields, edit.planId))).rows[0]);
        });
        if (edited !== undefined) return { status: 'edited', plan: edited };
        return { status: await refusalOf(pool, edit.planId, edit.userId) };
      }),

    finish: (finish) =>
      guarded(async (): Promise<FinishResult> => {
        const runId = context.newId();
        const done = await inTransaction(async (client) => {
          const [moved] = (await client.query(FINISH_PLAN, [finish.planId, finish.userId])).rows;
          if (moved === undefined) return false;
          await client.query(FINISH_RUN, [runId, finish.planId, finish.userId, finish.outcome, finish.rowCount, finish.elapsedMs]);
          return true;
        });
        return done ? { status: 'finished', runId } : { status: 'not-runnable' };
      }),

    sweep: (limit) => guarded(async () => (await pool.query(SWEEP, [limit])).rows.length),

    close: () => (closing ??= pool.end()),
  };
}
