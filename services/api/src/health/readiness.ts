import type { ReadyChecks, ReadyResponse } from '@neburyx/contracts';

export const READINESS_LIMIT_MS = 2000;
export const PROBE_STEP_MS = 1500;

export function readinessResponse(checks: ReadyChecks): { readonly statusCode: 200 | 503; readonly body: ReadyResponse } {
  const ready = Object.values(checks).every((state) => state === 'ok');
  return { statusCode: ready ? 200 : 503, body: { status: ready ? 'ready' : 'not_ready', checks } };
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
