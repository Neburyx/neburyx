import type { Check, CheckContext, CheckOutcome, Exec, ExecRequest, ExecResult } from './types.js';

export function execResult(overrides: Partial<ExecResult> = {}): ExecResult {
  return { exitCode: 0, output: '', timedOut: false, interrupted: false, ...overrides };
}

/** An Exec that answers by the program and its first argument, and records every request. */
export function fakeExec(answers: (request: ExecRequest) => ExecResult): { readonly exec: Exec; readonly requests: ExecRequest[] } {
  const requests: ExecRequest[] = [];
  return {
    requests,
    exec: (request) => {
      requests.push(request);
      return Promise.resolve(answers(request));
    },
  };
}

export function fakeCheck(id: string, outcome: Partial<CheckOutcome> = {}, onRun?: (context: CheckContext) => void): Check {
  return {
    id,
    name: `Check ${id}`,
    command: `run ${id}`,
    run: (context) => {
      onRun?.(context);
      return Promise.resolve({ status: 'passed', detail: 'ok', command: `run ${id}`, exitCode: 0, output: `output of ${id}`, ...outcome });
    },
  };
}

export function testContext(exec: Exec, signal: AbortSignal = new AbortController().signal): CheckContext {
  return { exec, signal, repoRoot: '/repo', commit: 'abcdef0123456789', monotonicNowMs: () => 0, workDir: '/work', env: {} };
}
