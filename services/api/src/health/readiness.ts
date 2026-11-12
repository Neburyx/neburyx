import type { ReadyChecks, ReadyResponse, SourceReachability } from '@neburyx/contracts';

export const READINESS_LIMIT_KEY = 'NEBURYX_READINESS_LIMIT_MS';
/** A load balancer needs a dead database reported in seconds, so the default stays short; a database name that takes longer to resolve than this is looked up once at start and not per probe. */
export const READINESS_LIMIT_MS = 2000;
export const MIN_READINESS_LIMIT_MS = 500;
export const MAX_READINESS_LIMIT_MS = 60_000;
/** The part of the limit kept for the query after the connection is open. A hypothesis: 500 ms makes the connection step 1 500 ms at the 2 000 ms default, as it was. */
export const PROBE_QUERY_RESERVE_MS = 500;
export const MIN_PROBE_STEP_MS = 250;

/** The readiness limit from the setting: absent or empty is the default; `undefined` is a value that is not a whole number of milliseconds in range. */
export function parseReadinessLimit(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return READINESS_LIMIT_MS;
  if (!/^\d+$/.test(value)) return undefined;
  const milliseconds = Number(value);
  return milliseconds >= MIN_READINESS_LIMIT_MS && milliseconds <= MAX_READINESS_LIMIT_MS ? milliseconds : undefined;
}

/** How long the probe pool waits for a connection, and for a statement, within a readiness limit. */
export function probeStepMs(limitMs: number): number {
  return Math.max(MIN_PROBE_STEP_MS, limitMs - PROBE_QUERY_RESERVE_MS);
}

/** The status depends on the checks only; the source counts are information beside them. */
export function readinessResponse(checks: ReadyChecks, sources: SourceReachability): { readonly statusCode: 200 | 503; readonly body: ReadyResponse } {
  const ready = Object.values(checks).every((state) => state === 'ok');
  return { statusCode: ready ? 200 : 503, body: { status: ready ? 'ready' : 'not_ready', checks, sources } };
}

export interface ReadinessSteps {
  ping(): Promise<void>;
  migrations(): Promise<ReadyChecks['migrations']>;
}

export async function runReadiness(steps: ReadinessSteps, limitMs: number): Promise<ReadyChecks> {
  const progress: ReadyChecks = { database: 'unreachable', migrations: 'unknown' };
  const work = (async (): Promise<ReadyChecks> => {
    try {
      await steps.ping();
    } catch {
      return progress;
    }
    progress.database = 'ok';
    try {
      return { database: 'ok', migrations: await steps.migrations() };
    } catch {
      return progress;
    }
  })();
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<ReadyChecks>((resolve) => {
    timer = setTimeout(() => resolve({ ...progress }), limitMs);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}
