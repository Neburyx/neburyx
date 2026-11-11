import { redact, redactDeep } from './redact.js';
import type { Check, CheckContext, CheckOutcome, CheckResult } from './types.js';

export interface RunnerDeps {
  readonly context: CheckContext;
  /** Masked in logs and details. */
  readonly secrets: readonly string[];
  /** Masked in the recorded figures; leaves out the login name, which can be a common word. */
  readonly dataSecrets: readonly string[];
  /** Saves a check's log and returns the path to name in the record. */
  readonly saveLog: (checkId: string, text: string) => Promise<string>;
  readonly monotonicNowMs: () => number;
}

const NOT_RUN = 'not run: interrupted';

function failedOutcome(check: Check, detail: string): CheckOutcome {
  return { status: 'failed', detail, command: check.command, exitCode: null, output: detail };
}

async function runOne(check: Check, deps: RunnerDeps): Promise<CheckOutcome> {
  try {
    const outcome = await check.run(deps.context);
    return deps.context.signal.aborted ? { ...outcome, status: 'failed', detail: 'interrupted' } : outcome;
  } catch (error) {
    return failedOutcome(check, `threw: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Runs the checks one at a time, in order, and never stops at a failure; after an interrupt the rest are listed as not run. */
export async function runChecks(checks: readonly Check[], deps: RunnerDeps): Promise<readonly CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    if (deps.context.signal.aborted) {
      results.push({ id: check.id, name: check.name, command: check.command, status: 'failed', exitCode: null, durationMs: 0, detail: NOT_RUN, log: '' });
      continue;
    }
    const started = deps.monotonicNowMs();
    const outcome = await runOne(check, deps);
    const durationMs = Math.round(deps.monotonicNowMs() - started);
    const log = await deps.saveLog(check.id, redact(outcome.output, deps.secrets));
    results.push({
      id: check.id,
      name: check.name,
      command: outcome.command,
      status: outcome.status,
      exitCode: outcome.exitCode,
      durationMs,
      detail: redact(outcome.detail, deps.secrets),
      log,
      ...(outcome.data === undefined ? {} : { data: redactDeep(outcome.data, deps.dataSecrets) }),
    });
  }
  return results;
}
