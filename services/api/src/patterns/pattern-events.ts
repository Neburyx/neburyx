import type pg from 'pg';
import type { AuditSink } from '@neburyx/contracts';
import { AppError } from '../errors.js';
import type { Principal } from '../seams/seams.js';

/**
 * The history of a pattern, in two records.
 * `pattern_events` is the pattern's own history. It is written in every edition, after the commit of the change, through a queue, so a store that cannot take an event never refuses or undoes a change.
 * Each event is also passed to the `AuditSink` seam. In Community that keeps nothing; in Enterprise the sink records it in `audit_events`, the second record.
 * An event holds ids, an action and a version, never a definition or a property value.
 */

/** The actions the table accepts, in the feature's own words. */
export const PATTERN_EVENT_ACTIONS = ['saved', 'changed', 'shared', 'unshared', 'copied', 'deleted'] as const;
export type PatternEventAction = (typeof PATTERN_EVENT_ACTIONS)[number];

/** The audit code of each action, in the noun and present tense of every audit code (`investigation.close`, `export.create`). */
export const PATTERN_AUDIT_ACTIONS: Readonly<Record<PatternEventAction, string>> = {
  saved: 'pattern.save',
  changed: 'pattern.change',
  shared: 'pattern.share',
  unshared: 'pattern.unshare',
  copied: 'pattern.copy',
  deleted: 'pattern.delete',
};

export interface PatternEvent {
  readonly id: string;
  readonly sourceId: string;
  readonly patternId: string;
  readonly actorId: string;
  readonly action: PatternEventAction;
  /** The pattern's version when the action happened; at least 1. */
  readonly version: number;
}

export function isPatternEventAction(value: unknown): value is PatternEventAction {
  return typeof value === 'string' && (PATTERN_EVENT_ACTIONS as readonly string[]).includes(value);
}

/**
 * Inserts one event of the pattern's history through a pool, with the time limit of the queue if it gives one (set on the statement at the server), outside the change's transaction. An event is inserted once whatever the number of tries: its id is fixed when the change is made, and a second insert of the same id writes nothing.
 * An action outside the list is a bug in the caller and throws a `TypeError` before any SQL is sent.
 */
const INSERT_EVENT = 'INSERT INTO pattern_events (id, source_id, pattern_id, actor_id, action, pattern_version) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING';

export async function insertPatternEvent(pool: Pick<pg.Pool, 'query' | 'connect'>, event: PatternEvent, timeoutMs?: number): Promise<void> {
  if (!isPatternEventAction(event.action)) {
    const length = typeof event.action === 'string' ? (event.action as string).length : 0;
    throw new TypeError(`a pattern event action must be one of the listed actions (the given one has ${length} characters)`);
  }
  const values = [event.id, event.sourceId, event.patternId, event.actorId, event.action, event.version];
  if (timeoutMs === undefined) {
    await pool.query(INSERT_EVENT, values);
    return;
  }
  // the server ends the statement at the limit, so the write is over when the queue stops waiting for it and the next event is not written before it
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('statement_timeout', $1, true)`, [String(Math.trunc(timeoutMs))]);
    await client.query(INSERT_EVENT, values);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Where a pattern's history events are handed to be written; recording one never waits and never throws. */
export interface PatternHistory {
  record(event: PatternEvent): Promise<void>;
}

export interface PatternTransactionDeps {
  readonly pool: pg.Pool;
  readonly audit: AuditSink;
  readonly history: PatternHistory;
  /** Makes the version 7 uuid of an event. */
  readonly newId: () => string;
}

export interface PatternTransactionContext {
  readonly principal: Principal;
  readonly traceId: string;
}

export interface PatternEventInput {
  readonly sourceId: string;
  readonly patternId: string;
  readonly action: PatternEventAction;
  readonly version: number;
}

export interface PatternTransaction {
  readonly client: pg.PoolClient;
  /** Notes an event of the change; it is handed to the history and to the audit seam after the commit. */
  record(input: PatternEventInput): Promise<void>;
}

/**
 * Runs the change of a pattern as one transaction and, after the commit, hands each event it noted, in the order noted, to the pattern's history and to the audit seam.
 * Both hand-overs are queued and never fail or wait, so a store that cannot take an event leaves a committed change as it is. A change that fails, or a commit that did not commit, hands over nothing.
 */
export async function inPatternTransaction<T>(deps: PatternTransactionDeps, context: PatternTransactionContext, work: (transaction: PatternTransaction) => Promise<T>): Promise<T> {
  const recorded: PatternEvent[] = [];
  const client = await deps.pool.connect();
  let result: T;
  try {
    await client.query('BEGIN');
    result = await work({
      client,
      record(input) {
        const event: PatternEvent = { id: deps.newId(), actorId: context.principal.id, ...input };
        if (!isPatternEventAction(event.action)) throw new TypeError('a pattern event action must be one of the listed actions');
        recorded.push(event);
        return Promise.resolve();
      },
    });
    // Postgres answers COMMIT of a transaction that failed with the command tag ROLLBACK and no error, so the tag is checked: nothing committed means no success and no hand-over
    const committed = await client.query('COMMIT');
    if (committed.command !== 'COMMIT') throw new AppError('INTERNAL_ERROR');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  for (const event of recorded) {
    await deps.history.record(event);
    await deps.audit.record({
      actorId: context.principal.id,
      actorRole: context.principal.role,
      action: PATTERN_AUDIT_ACTIONS[event.action],
      result: 'success',
      sourceId: event.sourceId,
      resourceType: 'pattern',
      resourceRef: event.patternId,
      traceId: context.traceId,
    });
  }
  return result;
}

export interface StoredPatternEvent extends PatternEvent {
  readonly createdAt: string;
}

export interface PatternEventFilter {
  readonly patternId?: string;
  readonly sourceId?: string;
}

interface EventRecord {
  readonly id: string;
  readonly source_id: string;
  readonly pattern_id: string;
  readonly actor_id: string;
  readonly action: PatternEventAction;
  readonly pattern_version: number;
  readonly created_at: Date;
}

/** Reads the events of one pattern or one source, oldest first. For tests: there is no read of the whole table, and no route reads the trail. */
export async function readPatternEvents(pool: Pick<pg.Pool, 'query'>, filter: PatternEventFilter): Promise<readonly StoredPatternEvent[]> {
  if (filter.patternId === undefined && filter.sourceId === undefined) throw new TypeError('events are read for one pattern or one source');
  const found = await pool.query<EventRecord>(
    `SELECT id, source_id, pattern_id, actor_id, action, pattern_version, created_at FROM pattern_events
     WHERE ($1::uuid IS NULL OR pattern_id = $1) AND ($2::text IS NULL OR source_id = $2) ORDER BY created_at, id`,
    [filter.patternId ?? null, filter.sourceId ?? null],
  );
  return found.rows.map((row) => ({
    id: row.id,
    sourceId: row.source_id,
    patternId: row.pattern_id,
    actorId: row.actor_id,
    action: row.action,
    version: row.pattern_version,
    createdAt: row.created_at.toISOString(),
  }));
}
