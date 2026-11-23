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
  readonly instructionsSha256: string;
  readonly instructionsText: string;
  /** What the model was sent after the system text: the messages with the lines of the reads. Real text over the run's own data; kept in the run file for the scorer's lines only. */
  readonly valuesText: string;
  readonly replyText: string | null;
  readonly toolsOffered: readonly string[] | null;
}

interface EventRecord {
  readonly action: string;
  readonly result: string;
  readonly sourceId: string | null;
  readonly tokensIn: number | 'unknown' | null;
  readonly tokensOut: number | 'unknown' | null;
  readonly cacheReadTokens: number | 'unknown' | null;
  readonly cacheWriteTokens: number | 'unknown' | null;
  /** The total the closing event of the turn states (`assistant.turn.closed`), where this is that event. */
  readonly modelCalls: number | null;
}

/** One call of an AI case summary drafted in the turn, from the summary's own run record. */
interface SummaryCallRecord {
  readonly number: number;
  readonly status: string | null;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
}

export interface TurnRecords {
  readonly traceId: string;
  readonly run: { readonly id: string; readonly outcome: string | null; readonly finished: boolean; readonly calls: number; readonly settings: Readonly<Record<string, unknown>> } | undefined;
  readonly calls: readonly CallRecord[];
  readonly events: readonly EventRecord[];
  /** The summary's own calls, read from the summary's run records of the turn and checked against its events (`ai.case-summary`). */
  readonly summaryCalls: number;
  readonly summaryUsage: readonly SummaryCallRecord[];
  /** The turn's calls by its records (router and agent calls of the run, plus the summary's) against the total its closing event states; undefined when there is no closing event. */
  readonly reconciled: { readonly counted: number; readonly stated: number; readonly agree: boolean } | undefined;
  /** Causes that make the records of this turn incomplete: a figure from such a turn is never presented as complete. */
  readonly problems: readonly string[];
}

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const count = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : null);
const tokens = (value: unknown): number | 'unknown' | null => (value === 'unknown' ? 'unknown' : count(value));
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const RUN = 'SELECT id, outcome, finished_at, calls, settings FROM assistant_runs WHERE trace_id = $1 ORDER BY started_at';
const CALLS = 'SELECT run_id, call_number, started_at, duration_ms, status, failure_kind, error_class, error_code, tokens_in, tokens_out, instructions_sha256, instructions_text, values_text, reply_text, tools_offered FROM assistant_run_calls WHERE run_id = ANY($1::uuid[]) ORDER BY started_at, call_number';
const SUMMARY_RUNS = 'SELECT id FROM summary_runs WHERE trace_id = $1 ORDER BY started_at';
const SUMMARY_CALLS = 'SELECT run_id, call_number, status, tokens_in, tokens_out FROM summary_run_calls WHERE run_id = ANY($1::uuid[]) ORDER BY run_id, call_number';
const EVENTS = 'SELECT id, action, result, source_id, detail FROM audit_events WHERE trace_id = $1 ORDER BY at';

/** How long to wait for records that are written after the answer is returned: how many reads and the pause between them. A turn whose records are still incomplete after the last read is returned with its problems named. */
export interface Waiting {
  readonly attempts: number;
  readonly delayMs: number;
  readonly sleep: (ms: number) => Promise<void>;
}

const NO_WAITING: Waiting = { attempts: 1, delayMs: 0, sleep: () => Promise.resolve() };

/** The causes that may still be written: a record that does not exist yet, a run or call not ended, an event not written. */
const PENDING = /no run record|no end in the record|not finished|no closing event|count/u;

/**
 * The records of one turn, read by its trace id: the run and its calls, the audit events of the model calls (with the cache token counts the call record does not hold), the summary's own run records and the total the closing
 * event states. A missing run, a run or call not ended, a gap in the call numbers, a closing event that is absent or whose count does not match the calls, or events that do not cover every call is named in `problems`; no figure is invented.
 */
export async function readTurnRecords(db: Db, traceId: string, waiting: Waiting = NO_WAITING): Promise<TurnRecords> {
  let records = await readOnce(db, traceId);
  for (let attempt = 1; attempt < waiting.attempts && records.problems.some((problem) => PENDING.test(problem)); attempt += 1) {
    await waiting.sleep(waiting.delayMs);
    records = await readOnce(db, traceId);
  }
  return records;
}

async function readOnce(db: Db, traceId: string): Promise<TurnRecords> {
  const problems: string[] = [];
  const runs = (await db.query(RUN, [traceId])).rows;
  const seen = new Set<string>();
  const events = (await db.query(EVENTS, [traceId])).rows.flatMap((row): EventRecord[] => {
    const id = text(row['id']);
    if (id !== null) {
      if (seen.has(id)) return [];
      seen.add(id);
    }
    const detail = isRecord(row['detail']) ? row['detail'] : {};
    const ai = isRecord(detail['ai']) ? detail['ai'] : {};
    const turn = isRecord(detail['turn']) ? detail['turn'] : {};
    return [{ action: text(row['action']) ?? '', result: text(row['result']) ?? '', sourceId: text(row['source_id']), tokensIn: tokens(ai['tokensIn']), tokensOut: tokens(ai['tokensOut']), cacheReadTokens: tokens(ai['cacheReadTokens']), cacheWriteTokens: tokens(ai['cacheWriteTokens']), modelCalls: count(turn['modelCalls']) }];
  });
  if (runs.length === 0) problems.push('no run record for this trace id');
  if (runs.length > 1) problems.push('more than one run record for this trace id');
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
    instructionsSha256: text(row['instructions_sha256']) ?? '',
    instructionsText: text(row['instructions_text']) ?? '',
    valuesText: text(row['values_text']) ?? '',
    replyText: text(row['reply_text']),
    toolsOffered: text(row['tools_offered']) === null ? null : (text(row['tools_offered']) ?? '').split(',').filter((name) => name !== ''),
  }));
  for (const call of calls) if (call.status === null) problems.push(`call ${call.number} was started and has no end in the record`);
  const first = runs[0];
  const run = first === undefined ? undefined : { id: text(first['id']) ?? '', outcome: text(first['outcome']), finished: first['finished_at'] !== null && first['finished_at'] !== undefined, calls: count(first['calls']) ?? 0, settings: isRecord(first['settings']) ? first['settings'] : {} };
  if (run !== undefined) {
    if (!run.finished || run.outcome === null) problems.push('the run is not finished in the record');
    if (run.calls !== calls.length) problems.push(`the run states ${run.calls} calls and the record holds ${calls.length}: count differs`);
    if (!calls.every((call, index) => call.number === index + 1)) problems.push('the call numbers of the record are not 1 to n: count differs');
  }
  const summaryRuns = (await db.query(SUMMARY_RUNS, [traceId])).rows.flatMap((row) => (typeof row['id'] === 'string' ? [row['id']] : []));
  const summaryUsage = summaryRuns.length === 0 ? [] : (await db.query(SUMMARY_CALLS, [summaryRuns])).rows.map((row): SummaryCallRecord => ({ number: count(row['call_number']) ?? 0, status: text(row['status']), tokensIn: count(row['tokens_in']), tokensOut: count(row['tokens_out']) }));
  for (const entry of summaryUsage) if (entry.status === null) problems.push(`summary call ${entry.number} was started and has no end in the record`);
  const summaryEvents = events.filter((event) => event.action === 'ai.case-summary').length;
  if (summaryEvents !== summaryUsage.length) problems.push(`the audit events name ${summaryEvents} summary calls and the summary records hold ${summaryUsage.length}: count differs`);
  const summaryCalls = summaryUsage.length;
  const closing = events.find((event) => event.modelCalls !== null);
  const counted = calls.length + summaryCalls;
  const reconciled = closing === undefined || closing.modelCalls === null ? undefined : { counted, stated: closing.modelCalls, agree: counted === closing.modelCalls };
  if (reconciled === undefined) problems.push('no closing event for this turn in the audit events');
  else if (!reconciled.agree) problems.push(`the records count ${counted} model calls and the closing event states ${reconciled.stated}: count differs`);
  const modelEvents = events.filter((event) => event.action === 'assistant.route' || event.action === 'assistant.agent').length;
  if (modelEvents !== calls.length) problems.push(`the audit events name ${modelEvents} router and agent calls and the record holds ${calls.length}: count differs`);
  return { traceId, run, calls, events, summaryCalls, summaryUsage, reconciled, problems };
}

/** The settings of every turn of a repeat must agree: the settings of the first turn that has a run, and the trace ids whose run shows other settings. */
export function settingsDisagreements(turns: readonly TurnRecords[]): readonly string[] {
  const runs = turns.flatMap((turn) => (turn.run === undefined ? [] : [{ traceId: turn.traceId, settings: JSON.stringify(turn.run.settings) }]));
  const first = runs[0]?.settings;
  return runs.filter((run) => run.settings !== first).map((run) => run.traceId);
}
