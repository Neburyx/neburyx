/** What the evaluation reader needs of a database: one read-only query. The real adapter is in `db.ts`; tests give a stand-in. */
export interface Db {
  readonly query: (text: string, values: readonly unknown[]) => Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}

interface CallRecord {
  readonly number: number;
  readonly startedAt: string;
  readonly durationMs: number | null;
  readonly status: string | null;
  readonly failureKind: string | null;
  readonly errorClass: string | null;
  readonly errorCode: string | null;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  /** What the model was sent after the system text: the messages with the lines of the reads. Real text over the run's own data; kept in the run file for the scorer's lines only. */
  readonly valuesText: string;
  readonly replyText: string | null;
}

interface EventRecord {
  readonly action: string;
  readonly result: string;
  readonly tokensIn: number | 'unknown' | null;
  readonly tokensOut: number | 'unknown' | null;
  readonly cacheReadTokens: number | 'unknown' | null;
  readonly cacheWriteTokens: number | 'unknown' | null;
  /** The total the closing event of the turn states (`assistant.turn.closed`), where this is that event. */
  readonly modelCalls: number | null;
}

export interface TurnRecords {
  readonly traceId: string;
  readonly run: { readonly outcome: string | null; readonly calls: number; readonly settings: Readonly<Record<string, unknown>> } | undefined;
  readonly calls: readonly CallRecord[];
  readonly events: readonly EventRecord[];
  /** The summary's own calls, found by their events (`ai.case-summary`). */
  readonly summaryCalls: number;
  /** The turn's calls by its records (router and agent calls of the run, plus the summary's) against the total its closing event states; undefined when there is no closing event. */
  readonly reconciled: { readonly counted: number; readonly stated: number; readonly agree: boolean } | undefined;
  /** Causes that make the records of this turn incomplete: a figure from such a turn is never presented as complete. */
  readonly problems: readonly string[];
}

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const count = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : null);
const tokens = (value: unknown): number | 'unknown' | null => (value === 'unknown' ? 'unknown' : count(value));
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const RUN = 'SELECT id, outcome, calls, settings FROM assistant_runs WHERE trace_id = $1 ORDER BY started_at';
const CALLS = 'SELECT run_id, call_number, started_at, duration_ms, status, failure_kind, error_class, error_code, tokens_in, tokens_out, values_text, reply_text FROM assistant_run_calls WHERE run_id = ANY($1::uuid[]) ORDER BY started_at, call_number';
const EVENTS = 'SELECT action, result, detail FROM audit_events WHERE trace_id = $1 ORDER BY at';

/**
 * The records of one turn, read by its trace id: the run and its calls, the audit events of the model calls (with the cache token counts the call record does not hold), the calls of an AI case summary drafted
 * in the turn, and the total the closing event states. A missing run, a call that was started and not ended, or a count that does not reconcile is named in `problems`; no figure is invented.
 */
export async function readTurnRecords(db: Db, traceId: string): Promise<TurnRecords> {
  const problems: string[] = [];
  const runs = (await db.query(RUN, [traceId])).rows;
  const events = (await db.query(EVENTS, [traceId])).rows.map((row): EventRecord => {
    const detail = isRecord(row['detail']) ? row['detail'] : {};
    const ai = isRecord(detail['ai']) ? detail['ai'] : {};
    const turn = isRecord(detail['turn']) ? detail['turn'] : {};
    return { action: text(row['action']) ?? '', result: text(row['result']) ?? '', tokensIn: tokens(ai['tokensIn']), tokensOut: tokens(ai['tokensOut']), cacheReadTokens: tokens(ai['cacheReadTokens']), cacheWriteTokens: tokens(ai['cacheWriteTokens']), modelCalls: count(turn['modelCalls']) };
  });
  if (runs.length === 0) problems.push('no run record for this trace id');
  const ids = runs.flatMap((run) => (typeof run['id'] === 'string' ? [run['id']] : []));
  const calls = ids.length === 0 ? [] : (await db.query(CALLS, [ids])).rows.map((row): CallRecord => ({
    number: count(row['call_number']) ?? 0,
    startedAt: row['started_at'] instanceof Date ? row['started_at'].toISOString() : (text(row['started_at']) ?? ''),
    durationMs: count(row['duration_ms']),
    status: text(row['status']),
    failureKind: text(row['failure_kind']),
    errorClass: text(row['error_class']),
    errorCode: text(row['error_code']),
    tokensIn: count(row['tokens_in']),
    tokensOut: count(row['tokens_out']),
    valuesText: text(row['values_text']) ?? '',
    replyText: text(row['reply_text']),
  }));
  for (const call of calls) if (call.status === null) problems.push(`call ${call.number} was started and has no end in the record`);
  const summaryCalls = events.filter((event) => event.action === 'ai.case-summary').length;
  const closing = events.find((event) => event.modelCalls !== null);
  const counted = calls.length + summaryCalls;
  const reconciled = closing?.modelCalls === null || closing === undefined ? undefined : { counted, stated: closing.modelCalls, agree: counted === closing.modelCalls };
  if (reconciled !== undefined && !reconciled.agree) problems.push(`the records count ${counted} model calls and the closing event states ${reconciled.stated}`);
  const first = runs[0];
  const run = first === undefined ? undefined : { outcome: text(first['outcome']), calls: count(first['calls']) ?? 0, settings: isRecord(first['settings']) ? first['settings'] : {} };
  return { traceId, run, calls, events, summaryCalls, reconciled, problems };
}

/** The settings of every turn of a repeat must agree: the settings of the first turn that has a run, and the trace ids whose run shows other settings. */
export function settingsDisagreements(turns: readonly TurnRecords[]): readonly string[] {
  const runs = turns.flatMap((turn) => (turn.run === undefined ? [] : [{ traceId: turn.traceId, settings: JSON.stringify(turn.run.settings) }]));
  const first = runs[0]?.settings;
  return runs.filter((run) => run.settings !== first).map((run) => run.traceId);
}
