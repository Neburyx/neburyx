/**
 * Ceiling of a read forced past a budget: the budget, the server's lag in stopping it, and ten ordinary reads for the round trips.
 * The lag is the server's transaction-timeout check interval (`db.transaction.monitor.check.interval`, default 2s, not dynamic; Neo4j Operations Manual 5, Configuration settings):
 * a timed-out read is stopped at the next check. On the 5.26 dev server a 1,000 ms budget was answered 703 to 1,054 ms late in 8 runs, a 150 ms one 272 to 789 ms late in 3,
 * so neither one read nor a short forced read stands for the lag. The ordinary read is timed after a first read of the same statement, since the first took about 1.4 s through the API rigs and 54 to 87 ms through the gate.
 */
const MARGIN_READS = 10;
const CALIBRATION_READS = 3;
export const INTERVAL_SETTING = 'db.transaction.monitor.check.interval';

/** The code of a read that answered `{ ok: false }`, quoted; undefined for any other answer. */
function failureOf(answer: unknown): string | undefined {
  if (typeof answer !== 'object' || answer === null || !('ok' in answer) || answer.ok !== false) return undefined;
  return 'failure' in answer && typeof answer.failure === 'object' && answer.failure !== null && 'code' in answer.failure ? JSON.stringify(answer.failure.code) : 'unknown';
}

const WARM_UP_ATTEMPTS = 3;
const TIMED_OUT = JSON.stringify('QUERY_TIMEOUT');

/**
 * Runs `read` until it succeeds, at most three times, so that the server has planned its statement before a case holds a read of it to a budget:
 * on the dev server the first read of a statement on a new database spent 1.3 to 1.8 s in planning, over a 1,000 ms budget.
 * Only a timeout is read again; another failure, an error the read throws, or three timeouts are an error.
 */
export async function warmUp(what: string, read: () => Promise<unknown>): Promise<void> {
  for (let attempt = 1; attempt <= WARM_UP_ATTEMPTS; attempt += 1) {
    const failure = failureOf(await read());
    if (failure === undefined) return;
    if (failure !== TIMED_OUT) throw new Error(`the warm-up of ${what} failed on read ${attempt} (${failure})`);
  }
  throw new Error(`the warm-up of ${what} did not succeed in ${WARM_UP_ATTEMPTS} reads (each ${TIMED_OUT})`);
}

/** Times one ordinary read in ms, at least 1; a read that answers `{ ok: false }` is an error, since its time says nothing of a read. */
export async function timeOneRead(read: () => Promise<unknown>): Promise<number> {
  const started = performance.now();
  const failure = failureOf(await read());
  if (failure !== undefined) throw new Error(`the ordinary read did not succeed (${failure}), so its time says nothing of a read`);
  return Math.max(1, Math.ceil(performance.now() - started));
}

/** Runs one read as a warm-up, its answer and any error ignored, then times the second. */
export async function timeWarmRead(read: () => Promise<unknown>): Promise<number> {
  await read().catch(() => undefined);
  return timeOneRead(read);
}

/** How far past `budgetMs` a forced read is answered, in ms, at least 1. */
export async function timeOvershoot(budgetMs: number, forced: () => Promise<unknown>): Promise<number> {
  const started = performance.now();
  await forced().catch(() => undefined);
  return Math.max(1, Math.ceil(performance.now() - started - budgetMs));
}

const UNIT_MS = new Map([['ms', 1], ['s', 1000], ['m', 60_000], ['h', 3_600_000]]);

/** A duration as the server writes a setting (`2s`, `500ms`, `1m`) in ms; undefined for anything else. */
export function durationMs(text: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/.exec(text.trim());
  const unit = UNIT_MS.get(match?.[2] ?? '');
  return match === null || unit === undefined ? undefined : Math.round(Number(match[1]) * unit);
}

interface SettingsReader {
  session(config: { readonly database: string }): {
    run(cypher: string, parameters?: Record<string, unknown>): Promise<{ readonly records: readonly { get(key: string): unknown }[] }>;
    close(): Promise<void>;
  };
}

export type ServerLag = { readonly lagMs: number; readonly via: 'setting' | 'calibration' };

/** The server's check interval, read through `admin`; where the login cannot read it, the largest overshoot of three forced reads from `forced`. */
export async function serverLag(admin: SettingsReader, forced: () => Promise<number>): Promise<ServerLag> {
  try {
    const session = admin.session({ database: 'system' });
    try {
      const result = await session.run('SHOW SETTINGS YIELD name, value WHERE name = $name RETURN value', { name: INTERVAL_SETTING });
      const value = result.records[0]?.get('value');
      const lagMs = typeof value === 'string' ? durationMs(value) : undefined;
      if (lagMs !== undefined) return { lagMs, via: 'setting' };
    } finally {
      await session.close();
    }
  } catch {
    // a login that cannot read settings is answered by the calibration below
  }
  const overshoots: number[] = [];
  for (let each = 0; each < CALIBRATION_READS; each += 1) overshoots.push(await forced());
  return { lagMs: Math.max(...overshoots), via: 'calibration' };
}

export const ceilingOf = (budgetMs: number, lagMs: number, ordinaryReadMs: number): number => budgetMs + lagMs + MARGIN_READS * ordinaryReadMs;
