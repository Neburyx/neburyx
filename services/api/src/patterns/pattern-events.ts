import type pg from 'pg';
import type { AuditSink } from '@neburyx/contracts';
import { AppError } from '../errors.js';
import type { Principal } from '../seams/seams.js';

/**
 * The history of a pattern, in two records.
 * `pattern_events` is the pattern's own history. It is written in every edition, inside the transaction of the change, so a change that cannot be recorded is refused with `AUDIT_UNAVAILABLE`.
 * After the commit each event is also passed to the `AuditSink` seam. In Community that keeps nothing; in Enterprise the sink records it in `audit_events`, the second record.
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
 * Inserts one event with the caller's open client, in the caller's transaction, and opens none of its own.
 * An action outside the list is a bug in the caller and throws a `TypeError` before any SQL is sent. A failed insert throws `AUDIT_UNAVAILABLE` with no details, so the change in the same transaction rolls back.
 */
export async function recordPatternEvent(client: Pick<pg.PoolClient, 'query'>, event: PatternEvent): Promise<void> {
  if (!isPatternEventAction(event.action)) {
    const length = typeof event.action === 'string' ? (event.action as string).length : 0;
    throw new TypeError(`a pattern event action must be one of the listed actions (the given one has ${length} characters)`);
  }
  try {
    await client.query('INSERT INTO pattern_events (id, source_id, pattern_id, actor_id, action, pattern_version) VALUES ($1, $2, $3, $4, $5, $6)', [
      event.id,
      event.sourceId,
      event.patternId,
      event.actorId,
      event.action,
      event.version,
    ]);
  } catch {
    throw new AppError('AUDIT_UNAVAILABLE');
  }
}

export interface PatternTransactionDeps {
  readonly pool: pg.Pool;
  readonly audit: AuditSink;
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
  /** Records an event for the person who made the change, in this transaction. */
  record(input: PatternEventInput): Promise<void>;
}

/**
 * Runs the change of a pattern and its events as one transaction, and only after the commit passes each event, in the order recorded, to the audit seam.
 * A failed event write or a failed change rolls everything back and makes no seam call, also when the work caught the error: a failed event write is refused after the work returns, and a commit that did not commit is an error.
 * Interim rule for a sink that rejects (the final rule is set with the Enterprise audit log), taken from how a committed investigation change behaves: the commit stands, every event is still passed on, and the call throws `INTERNAL_ERROR`.
 */
export async function inPatternTransaction<T>(deps: PatternTransactionDeps, context: PatternTransactionContext, work: (transaction: PatternTransaction) => Promise<T>): Promise<T> {
  const recorded: PatternEvent[] = [];
  const client = await deps.pool.connect();
  let result: T;
  try {
    await client.query('BEGIN');
    let writeFailed = false;
    result = await work({
      client,
      async record(input) {
        const event: PatternEvent = { id: deps.newId(), actorId: context.principal.id, ...input };
        try {
          await recordPatternEvent(client, event);
        } catch (error) {
          writeFailed = true;
          throw error;
        }
        recorded.push(event);
      },
    });
    // a change whose event could not be written is refused even when the work caught that error
    if (writeFailed) throw new AppError('AUDIT_UNAVAILABLE');
    // Postgres answers COMMIT of a transaction that failed with the command tag ROLLBACK and no error, so the tag is checked: nothing committed means no success and no seam call
    const committed = await client.query('COMMIT');
    if (committed.command !== 'COMMIT') throw new AppError('INTERNAL_ERROR');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  let rejected = false;
  for (const event of recorded) {
    await deps.audit
      .record({
        actorId: context.principal.id,
        actorRole: context.principal.role,
        action: PATTERN_AUDIT_ACTIONS[event.action],
        result: 'success',
        sourceId: event.sourceId,
        resourceType: 'pattern',
        resourceRef: event.patternId,
        traceId: context.traceId,
      })
      .catch(() => {
        rejected = true;
      });
  }
  if (rejected) throw new AppError('INTERNAL_ERROR');
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
