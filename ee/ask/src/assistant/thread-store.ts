import { assistantThreadResponseSchema, assistantThreadTurnWriteSchema, storedAnswerSchema, type AssistantThreadResponse, type AssistantThreadTurnWrite, type AuditSinkContext, type StoredTurnText } from '@neburyx/contracts';
import pg from 'pg';
import { READ_EPOCH } from './thread-epoch.js';
import { randomUUID } from 'node:crypto';

/** The size of the pool the store keeps of its own: a write is one short transaction. */
const THREAD_POOL_SIZE = 2;

/** What a failed statement says: a fixed message, never the driver's text, the statement or a stored value. */
export class AssistantThreadStoreError extends Error {
  readonly code = 'ASSISTANT_THREAD_STORE_FAILED';

  constructor() {
    super('the thread of an assistant turn could not be stored or read');
    this.name = 'AssistantThreadStoreError';
  }
}

/** The commit of a clearing failed or was cut off: the thread may or may not have been deleted. Any other failure of a clearing happened before the commit, which is rolled back. */
export class AssistantThreadOutcomeUnknownError extends AssistantThreadStoreError {}

/** What an append did: the turn was stored, was already there (a retry), or was refused because its investigation is closed, deleted or was cleared since the turn began. */
type AppendResult = 'stored' | 'duplicate' | 'refused';

/** What a turn gives the router as context: its route, outcome, cause and intent and the references it ran and cited, never a text. */
export interface AssistantContextTurn {
  readonly route: AssistantThreadTurnWrite['route'];
  readonly outcome: AssistantThreadTurnWrite['outcome'];
  readonly cause?: string;
  readonly intent?: string;
  readonly entities: AssistantThreadTurnWrite['entities'];
  readonly citationRefs: AssistantThreadTurnWrite['citationRefs'];
}

/** A read of the thread as the store gives it: each turn as the panel is told of it, and beside it the text it kept, before the mask and the sensitivity version decide what is sent. */
export interface AssistantThreadRead {
  readonly turns: readonly (AssistantThreadResponse['turns'][number] & { readonly stored?: StoredTurnText })[];
  readonly earlierTurns: number;
  readonly previousThreadClearedAt: string | null;
  readonly epoch: number;
}

/** Where a page of threads starts: after the thread whose last turn was at `key` (microsecond text) with this `id`. */
export interface ThreadListPosition {
  readonly key: string;
  readonly id: string;
}

/** One thread of the chat list: its investigation, when its last turn was stored, how many turns it holds and the full text of its newest stored question. */
export interface ThreadListRow {
  readonly threadId: string;
  readonly investigationId: string;
  readonly lastTurnAt: string;
  readonly key: string;
  readonly turns: number;
  readonly lastQuestion: string | null;
}

export interface AssistantThreadStore {
  /** How many times the investigation has been cleared plus how many times this person has cleared their own thread of it; 0 when neither. Both only grow, so the sum never repeats a value a turn holds. Read before a turn does any other work. */
  epoch(investigationId: string, userId: string): Promise<number>;
  /** Appends a turn to the person's thread, created if there is none, for the epoch the turn read; safe to write twice. */
  append(turn: AssistantThreadTurnWrite, epoch: number): Promise<AppendResult>;
  /** Whether an id a panel gave a turn is free for this person's thread of this investigation: it is not when a turn of another person's thread, or of another investigation, already has it. A turn of the same thread with the id is the same turn tried again. */
  turnIdTaken(turnId: string, investigationId: string, userId: string): Promise<boolean>;
  /** The caller's own thread of the investigation, its most recent `limit` turns and how many older ones there are, and when the caller's previous thread was cleared if they have no thread since. */
  read(investigationId: string, userId: string, limit: number): Promise<AssistantThreadRead>;
  /** The caller's own most recent `limit` turns of the investigation with the references they ran and cited, oldest first; none for a caller with no thread. */
  readContext(investigationId: string, userId: string, limit: number): Promise<readonly AssistantContextTurn[]>;
  /** Deletes the caller's own thread of the investigation and blanks the text of the model calls of their runs of it, in one transaction; true when a thread was deleted, false when they had none. Another person's thread and another investigation are not touched. */
  clearOwn(investigationId: string, userId: string): Promise<boolean>;
  /** The caller's own threads, newest last turn first (ties by thread id), `limit` of them after the position given: one statement over the application's tables, never the source. Nothing here says whether the investigation may be shown: the application's `chatInvestigations` decides that. */
  listOwn(userId: string, after: ThreadListPosition | undefined, limit: number): Promise<readonly ThreadListRow[]>;
  close(): Promise<void>;
}

export interface ThreadClient {
  query(text: string, values?: readonly unknown[]): Promise<{ readonly rows: readonly Record<string, unknown>[]; readonly rowCount?: number | null }>;
  release(): void;
}

export interface ThreadPool {
  connect(): Promise<ThreadClient>;
  end(): Promise<void>;
  on(event: 'error', listener: () => void): unknown;
}

interface Deps {
  readonly createPool: (config: pg.PoolConfig) => ThreadPool;
}

const defaultDeps: Deps = { createPool: (config) => new pg.Pool(config) };

const LOCK_INVESTIGATION = 'SELECT status, deleted_at IS NOT NULL AS deleted FROM investigations WHERE id = $1 FOR SHARE';
const LOCK_FOR_CLEAR = 'SELECT 1 FROM investigations WHERE id = $1 FOR NO KEY UPDATE';
const BUMP_PERSON_EPOCH = 'INSERT INTO assistant_thread_person_epochs (investigation_id, user_id, epoch) VALUES ($1, $2, 1) ON CONFLICT (investigation_id, user_id) DO UPDATE SET epoch = assistant_thread_person_epochs.epoch + 1';
const FIND_TURN = 'SELECT 1 FROM assistant_turns WHERE id = $1';
const UPSERT_THREAD =
  'INSERT INTO assistant_threads (id, investigation_id, user_id, created_at, last_turn_at) VALUES ($1, $2, $3, $4, $4) ON CONFLICT (investigation_id, user_id) DO UPDATE SET last_turn_at = GREATEST(assistant_threads.last_turn_at, EXCLUDED.last_turn_at) RETURNING id';
const NEXT_SEQ = 'SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM assistant_turns WHERE thread_id = $1';
const INSERT_TURN =
  'INSERT INTO assistant_turns (id, thread_id, seq, at, route, outcome, cause, question_hash, intent, template_id, entities, citation_refs, steps, model_ref, prompt_version, tokens_in, tokens_out, run_id, question_text, mask_on, answer, sensitivity_version) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22) ON CONFLICT (id) DO NOTHING';
const TURN_OWNER = 'SELECT h.investigation_id, h.user_id FROM assistant_turns t JOIN assistant_threads h ON h.id = t.thread_id WHERE t.id = $1';
const READ_TURNS =
  'SELECT t.id, t.seq, t.at, t.route, t.outcome, t.cause, t.intent, t.steps, jsonb_array_length(t.citation_refs) AS cited, t.question_text, t.mask_on, t.answer, t.sensitivity_version, h.id AS thread_id FROM assistant_turns t JOIN assistant_threads h ON h.id = t.thread_id WHERE h.investigation_id = $1 AND h.user_id = $2 ORDER BY t.seq DESC LIMIT $3';
const READ_CONTEXT =
  'SELECT t.route, t.outcome, t.cause, t.intent, t.entities, t.citation_refs FROM assistant_turns t JOIN assistant_threads h ON h.id = t.thread_id WHERE h.investigation_id = $1 AND h.user_id = $2 ORDER BY t.seq DESC LIMIT $3';
const COUNT_TURNS = 'SELECT count(*)::int AS n FROM assistant_turns t JOIN assistant_threads h ON h.id = t.thread_id WHERE h.investigation_id = $1 AND h.user_id = $2';
const READ_CLEARED = 'SELECT cleared_at FROM assistant_thread_clears WHERE investigation_id = $1 AND user_id = $2';
const DELETE_OWN_THREAD = 'DELETE FROM assistant_threads WHERE investigation_id = $1 AND user_id = $2';
const BLANK_OWN_CALLS = "UPDATE assistant_run_calls SET values_text = '', reply_text = NULL WHERE run_id IN (SELECT id FROM assistant_runs WHERE actor_id = $2 AND investigation_id = $1)";
const LIST_OWN_THREADS =
  `SELECT h.id, h.investigation_id, h.last_turn_at, to_char(h.last_turn_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS key,
          (SELECT count(*)::int FROM assistant_turns t WHERE t.thread_id = h.id) AS turns,
          (SELECT t.question_text FROM assistant_turns t WHERE t.thread_id = h.id AND t.question_text IS NOT NULL ORDER BY t.seq DESC LIMIT 1) AS question
   FROM assistant_threads h
   WHERE h.user_id = $1 AND ($2::text IS NULL OR (h.last_turn_at, h.id) < ($2::timestamptz, $3::uuid))
   ORDER BY h.last_turn_at DESC, h.id DESC
   LIMIT $4`;
const FORGET_OWN_CLEARING = 'DELETE FROM assistant_thread_clears WHERE investigation_id = $1 AND user_id = $2';
const HAS_THREAD = 'SELECT 1 FROM assistant_threads WHERE investigation_id = $1 AND user_id = $2';

/** A stored answer as the driver gave it: JSON text or an object; text that is not JSON is nothing. */
function parsedOrNothing(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** The text a stored row kept, as the store hands it on: an answer that does not read as the stored form is none. */
function storedOf(row: Record<string, unknown> | undefined): { readonly stored?: StoredTurnText } {
  if (row === undefined) return {};
  const answer = row['answer'] === null || row['answer'] === undefined ? undefined : storedAnswerSchema.safeParse(parsedOrNothing(row['answer']));
  const stored: StoredTurnText = {
    ...(row['question_text'] === null || row['question_text'] === undefined ? {} : { question: String(row['question_text']) }),
    ...(row['mask_on'] === null || row['mask_on'] === undefined ? {} : { maskOn: row['mask_on'] === true }),
    ...(answer?.success === true ? { answer: answer.data } : {}),
    ...(row['sensitivity_version'] === null || row['sensitivity_version'] === undefined ? {} : { sensitivityVersion: String(row['sensitivity_version']) }),
  };
  return Object.keys(stored).length === 0 ? {} : { stored };
}

const isoOf = (value: unknown): string => (value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString());
const numberOf = (value: unknown): number => Number(value);
const orNull = <T>(value: T | undefined): T | null => (value === undefined ? null : value);

/** Keeps the threads through the application's own database login, on a pool of its own. The write is one transaction that serializes against the closing of the investigation. */
export function createPgAssistantThreadStore(context: AuditSinkContext, deps: Deps = defaultDeps): AssistantThreadStore {
  const pool = deps.createPool({
    connectionString: context.databaseUrl,
    max: THREAD_POOL_SIZE,
    ...(context.connectionStream === undefined ? {} : { stream: context.connectionStream }),
    connectionTimeoutMillis: context.connectionTimeoutMs,
    statement_timeout: context.statementTimeoutMs,
    query_timeout: context.queryTimeoutMs,
  });
  pool.on('error', context.onConnectionError);
  let closing: Promise<void> | undefined;

  /** Runs the work on one connection; every failure is the fixed error, never the driver's text. */
  async function withClient<T>(work: (client: ThreadClient) => Promise<T>): Promise<T> {
    let client: ThreadClient;
    try {
      client = await pool.connect();
    } catch {
      throw new AssistantThreadStoreError();
    }
    try {
      return await work(client);
    } catch (error) {
      // the one failure that says more than the fixed error: a commit that may have happened
      throw error instanceof AssistantThreadOutcomeUnknownError ? error : new AssistantThreadStoreError();
    } finally {
      client.release();
    }
  }

  return {
    turnIdTaken: (turnId, investigationId, userId) =>
      withClient(async (client) => {
        const owner = (await client.query(TURN_OWNER, [turnId])).rows[0];
        return owner !== undefined && (String(owner['investigation_id']).toLowerCase() !== investigationId.toLowerCase() || String(owner['user_id']).toLowerCase() !== userId.toLowerCase());
      }),
    epoch: (investigationId, userId) =>
      withClient(async (client) => {
        const result = await client.query(READ_EPOCH, [investigationId, userId]);
        return result.rows[0] === undefined ? 0 : numberOf(result.rows[0]['epoch']);
      }),
    append: (turn, epoch) =>
      withClient(async (client) => {
        const checked = assistantThreadTurnWriteSchema.parse(turn);
        await client.query('BEGIN');
        try {
          const investigation = (await client.query(LOCK_INVESTIGATION, [checked.investigationId])).rows[0];
          const current = (await client.query(READ_EPOCH, [checked.investigationId, checked.userId])).rows[0];
          if (investigation === undefined || investigation['status'] !== 'open' || investigation['deleted'] === true || (current === undefined ? 0 : numberOf(current['epoch'])) !== epoch) {
            await client.query('ROLLBACK');
            return 'refused' as const;
          }
          if ((await client.query(FIND_TURN, [checked.id])).rows[0] !== undefined) {
            await client.query('ROLLBACK');
            return 'duplicate' as const;
          }
          const thread = (await client.query(UPSERT_THREAD, [randomUUID(), checked.investigationId, checked.userId, checked.at])).rows[0];
          const threadId = thread?.['id'];
          const seq = numberOf((await client.query(NEXT_SEQ, [threadId])).rows[0]?.['seq']);
          const inserted = await client.query(INSERT_TURN, [checked.id, threadId, seq, checked.at, checked.route, checked.outcome, orNull(checked.cause), checked.questionHash, orNull(checked.intent), orNull(checked.templateId), JSON.stringify(checked.entities), JSON.stringify(checked.citationRefs), checked.steps, orNull(checked.modelRef), orNull(checked.promptVersion), orNull(checked.tokensIn), orNull(checked.tokensOut), orNull(checked.runId), orNull(checked.question), orNull(checked.maskOn), checked.answer === undefined ? null : JSON.stringify(checked.answer), orNull(checked.sensitivityVersion)]);
          await client.query('COMMIT');
          return (inserted.rowCount ?? 0) === 0 ? ('duplicate' as const) : ('stored' as const);
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        }
      }),
    read: (investigationId, userId, limit) =>
      withClient(async (client) => {
        // one snapshot for the three reads, so a close or an append between them cannot give old turns with a new clearing
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        try {
          const recent = (await client.query(READ_TURNS, [investigationId, userId, limit])).rows;
          const total = numberOf((await client.query(COUNT_TURNS, [investigationId, userId])).rows[0]?.['n']);
          const hasThread = (await client.query(HAS_THREAD, [investigationId, userId])).rows[0] !== undefined;
          const epochRow = (await client.query(READ_EPOCH, [investigationId, userId])).rows[0];
          const cleared = hasThread ? undefined : (await client.query(READ_CLEARED, [investigationId, userId])).rows[0];
          await client.query('COMMIT');
          const parsed = assistantThreadResponseSchema.parse({
            turns: [...recent].reverse().map((row) => ({
              id: String(row['id']),
              seq: numberOf(row['seq']),
              at: isoOf(row['at']),
              route: row['route'],
              outcome: row['outcome'],
              ...(row['cause'] === null || row['cause'] === undefined ? {} : { cause: String(row['cause']) }),
              ...(row['intent'] === null || row['intent'] === undefined ? {} : { intent: String(row['intent']) }),
              citedElements: numberOf(row['cited']),
              steps: numberOf(row['steps']),
            })),
            earlierTurns: Math.max(0, total - recent.length),
            previousThreadClearedAt: cleared === undefined ? null : isoOf(cleared['cleared_at']),
            epoch: epochRow === undefined ? 0 : numberOf(epochRow['epoch']),
          });
          // the text each turn kept rides beside the turn, outside the public shape, for the route to decide what is sent
          return { ...parsed, epoch: epochRow === undefined ? 0 : numberOf(epochRow['epoch']), turns: parsed.turns.map((turn, index) => ({ ...turn, ...storedOf([...recent].reverse()[index]) })) };
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        }
      }),
    readContext: (investigationId, userId, limit) =>
      withClient(async (client) => {
        const rows = (await client.query(READ_CONTEXT, [investigationId, userId, limit])).rows;
        return [...rows].reverse().map((row) => ({
          route: assistantThreadTurnWriteSchema.shape.route.parse(row['route']),
          outcome: assistantThreadTurnWriteSchema.shape.outcome.parse(row['outcome']),
          ...(row['cause'] === null || row['cause'] === undefined ? {} : { cause: String(row['cause']) }),
          ...(row['intent'] === null || row['intent'] === undefined ? {} : { intent: String(row['intent']) }),
          entities: assistantThreadTurnWriteSchema.shape.entities.parse(row['entities']),
          citationRefs: assistantThreadTurnWriteSchema.shape.citationRefs.parse(row['citation_refs']),
        }));
      }),
    clearOwn: (investigationId, userId) =>
      withClient(async (client) => {
        await client.query('BEGIN');
        let committing = false;
        try {
          // the investigation row is locked first, as the append and the writes of a run record lock it to check the count, so each of them is wholly before the clearing or wholly after it
          if ((await client.query(LOCK_FOR_CLEAR, [investigationId])).rows[0] === undefined) {
            await client.query('ROLLBACK');
            return false;
          }
          const deleted = await client.query(DELETE_OWN_THREAD, [investigationId, userId]);
          await client.query(BLANK_OWN_CALLS, [investigationId, userId]);
          await client.query(FORGET_OWN_CLEARING, [investigationId, userId]);
          await client.query(BUMP_PERSON_EPOCH, [investigationId, userId]);
          committing = true;
          await client.query('COMMIT');
          return (deleted.rowCount ?? 0) > 0;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw committing ? new AssistantThreadOutcomeUnknownError() : error;
        }
      }),
    listOwn: (userId, after, limit) =>
      withClient(async (client) => {
        const result = await client.query(LIST_OWN_THREADS, [userId, after?.key ?? null, after?.id ?? null, limit]);
        return result.rows.map((row) => ({
          threadId: String(row['id']),
          investigationId: String(row['investigation_id']),
          lastTurnAt: (row['last_turn_at'] instanceof Date ? row['last_turn_at'] : new Date(String(row['last_turn_at']))).toISOString(),
          key: String(row['key']),
          turns: numberOf(row['turns']),
          lastQuestion: typeof row['question'] === 'string' ? row['question'] : null,
        }));
      }),
    close: () => (closing ??= pool.end()),
  };
}

interface MemoryThread {
  readonly id: string;
  readonly turns: AssistantThreadTurnWrite[];
}

interface MemoryInvestigation {
  open: boolean;
  deleted: boolean;
  epoch: number;
}

export interface MemoryAssistantThreadStore extends AssistantThreadStore {
  /** The threads by `investigation:user`, for a test to read. */
  readonly threads: Map<string, MemoryThread>;
  readonly investigations: Map<string, MemoryInvestigation>;
  /** The count that a turn reads: the investigation's plus the person's own, without the failure a read can be made to have. */
  epochOf(investigationId: string, userId: string): number;
  /** What the trigger of the migration does when the investigation is closed, archived or deleted. */
  clear(investigationId: string): void;
  reopen(investigationId: string): void;
}

/** Only a test uses this: the behaviour of the store and of the trigger kept in memory, and a store that can be made to fail, so no database is needed. */
export function createMemoryAssistantThreadStore(options: { readonly failOn?: 'epoch' | 'append' | 'read' | 'clear' | 'commit'; readonly now?: () => Date; /** What the same transaction does to the run records of the person's runs of the investigation; a test gives the memory run store's. */ readonly blankRunText?: (investigationId: string, userId: string) => void } = {}): MemoryAssistantThreadStore {
  const threads = new Map<string, MemoryThread>();
  const investigations = new Map<string, MemoryInvestigation>();
  const cleared = new Map<string, Date>();
  const personal = new Map<string, number>();
  const key = (investigationId: string, userId: string): string => `${investigationId}:${userId}`;
  const state = (investigationId: string): MemoryInvestigation => {
    const held = investigations.get(investigationId);
    if (held !== undefined) return held;
    const made = { open: true, deleted: false, epoch: 0 };
    investigations.set(investigationId, made);
    return made;
  };
  const fail = (step: 'epoch' | 'append' | 'read' | 'clear'): void => {
    if (options.failOn === step) throw new AssistantThreadStoreError();
  };
  return {
    threads,
    investigations,
    epochOf: (investigationId, userId) => state(investigationId).epoch + (personal.get(key(investigationId, userId)) ?? 0),
    clear(investigationId) {
      const held = state(investigationId);
      held.open = false;
      held.epoch += 1;
      for (const [name, thread] of threads) {
        if (thread.turns[0]?.investigationId !== investigationId) continue;
        cleared.set(name, (options.now ?? (() => new Date()))());
        threads.delete(name);
      }
    },
    reopen(investigationId) {
      state(investigationId).open = true;
    },
    async turnIdTaken(turnId, investigationId, userId) {
      fail('epoch');
      const own = key(investigationId, userId).toLowerCase();
      for (const [name, thread] of threads) if (thread.turns.some((held) => held.id.toLowerCase() === turnId.toLowerCase())) return name.toLowerCase() !== own;
      return false;
    },
    async epoch(investigationId, userId) {
      fail('epoch');
      return state(investigationId).epoch + (personal.get(key(investigationId, userId)) ?? 0);
    },
    async append(turn, epoch) {
      fail('append');
      const checked = assistantThreadTurnWriteSchema.parse(turn);
      const held = state(checked.investigationId);
      if (!held.open || held.deleted || held.epoch + (personal.get(key(checked.investigationId, checked.userId)) ?? 0) !== epoch) return 'refused';
      const name = key(checked.investigationId, checked.userId);
      const thread = threads.get(name) ?? { id: randomUUID(), turns: [] };
      if ([...threads.values()].some((other) => other.turns.some((held) => held.id === checked.id))) return 'duplicate';
      thread.turns.push(checked);
      threads.set(name, thread);
      return 'stored';
    },
    async read(investigationId, userId, limit) {
      fail('read');
      const name = key(investigationId, userId);
      const thread = threads.get(name);
      const when = cleared.get(name);
      const all = thread?.turns ?? [];
      const first = Math.max(0, all.length - limit);
      return {
        turns: all.slice(first).map((turn, index) => ({
          id: turn.id,
          seq: first + index + 1,
          at: turn.at.toISOString(),
          route: turn.route,
          outcome: turn.outcome,
          ...(turn.cause === undefined ? {} : { cause: turn.cause }),
          ...(turn.intent === undefined ? {} : { intent: turn.intent }),
          citedElements: turn.citationRefs.length,
          steps: turn.steps,
          ...(turn.question === undefined && turn.answer === undefined ? {} : { stored: { ...(turn.question === undefined ? {} : { question: turn.question }), ...(turn.maskOn === undefined ? {} : { maskOn: turn.maskOn }), ...(turn.answer === undefined ? {} : { answer: turn.answer }), ...(turn.sensitivityVersion === undefined ? {} : { sensitivityVersion: turn.sensitivityVersion }) } }),
        })),
        earlierTurns: first,
        previousThreadClearedAt: thread === undefined && when !== undefined ? when.toISOString() : null,
        epoch: state(investigationId).epoch + (personal.get(name) ?? 0),
      };
    },
    async readContext(investigationId, userId, limit) {
      fail('read');
      return (threads.get(key(investigationId, userId))?.turns ?? []).slice(-limit).map((turn) => ({
        route: turn.route,
        outcome: turn.outcome,
        ...(turn.cause === undefined ? {} : { cause: turn.cause }),
        ...(turn.intent === undefined ? {} : { intent: turn.intent }),
        entities: turn.entities,
        citationRefs: turn.citationRefs,
      }));
    },
    async clearOwn(investigationId, userId) {
      fail('clear');
      const name = key(investigationId, userId);
      const had = threads.delete(name);
      cleared.delete(name);
      personal.set(name, (personal.get(name) ?? 0) + 1);
      options.blankRunText?.(investigationId, userId);
      // the commit's failure leaves the outcome unknown: the twin has applied the clearing, the worst case for a claim that nothing was deleted
      if (options.failOn === 'commit') throw new AssistantThreadOutcomeUnknownError();
      return had;
    },
    async listOwn(userId, after, limit) {
      fail('read');
      const keyOf = (at: string): string => `${at.slice(0, -1)}000Z`;
      const rows: ThreadListRow[] = [];
      for (const thread of threads.values()) {
        const [first] = thread.turns;
        if (first === undefined || first.userId.toLowerCase() !== userId.toLowerCase()) continue;
        const last = thread.turns.reduce((newest, turn) => (turn.at.getTime() > newest.getTime() ? turn.at : newest), first.at).toISOString();
        const question = [...thread.turns].reverse().find((turn) => turn.question !== undefined)?.question;
        rows.push({ threadId: thread.id, investigationId: first.investigationId, lastTurnAt: last, key: keyOf(last), turns: thread.turns.length, lastQuestion: question ?? null });
      }
      return rows
        .sort((left, right) => (left.key < right.key ? 1 : left.key > right.key ? -1 : left.threadId < right.threadId ? 1 : -1))
        .filter((row) => after === undefined || row.key < after.key || (row.key === after.key && row.threadId < after.id))
        .slice(0, limit);
    },
    async close() {},
  };
}
