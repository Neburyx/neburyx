import { testsPassed } from './test-output.js';
import type { Check, CheckContext, CheckOutcome, ExecRequest, ExecResult } from './types.js';

export function describeCommand(request: Pick<ExecRequest, 'command' | 'args'>): string {
  return [request.command, ...request.args].join(' ');
}

/** The failure an exec result shows on its own, or undefined when the program exited 0. */
export function execFailure(result: ExecResult, timeoutMs: number | undefined): string | undefined {
  if (result.startError !== undefined) return `could not start: ${result.startError}`;
  if (result.interrupted) return 'interrupted';
  if (result.timedOut) return `timed out after ${timeoutMs ?? 0} ms`;
  if (result.exitCode !== 0) return `exited with code ${result.exitCode ?? 'none'}`;
  return undefined;
}

export interface CommandCheckOptions {
  readonly id: string;
  readonly name: string;
  /** Run in order; the first that fails ends the check. */
  readonly requests: readonly ExecRequest[];
  /** True for a test run: the last request must report at least one passed test. */
  readonly expectsTests?: boolean;
}

export function commandCheck(options: CommandCheckOptions): Check {
  const command = options.requests.map(describeCommand).join(' && ');
  return {
    id: options.id,
    name: options.name,
    command,
    run: async (context: CheckContext): Promise<CheckOutcome> => {
      const outputs: string[] = [];
      let last: ExecResult | undefined;
      for (const request of options.requests) {
        last = await context.exec(request);
        outputs.push(last.output);
        const failure = execFailure(last, request.timeoutMs);
        if (failure !== undefined) return { command, exitCode: last.exitCode, output: outputs.join(''), status: 'failed', detail: failure };
      }
      const base = { command, exitCode: last?.exitCode ?? null, output: outputs.join('') };
      if (options.expectsTests !== true) return { ...base, status: 'passed', detail: 'exit 0' };
      const passed = testsPassed(last?.output ?? '');
      if (passed === undefined || passed < 1) return { ...base, status: 'failed', detail: 'no tests ran' };
      return { ...base, status: 'passed', detail: `${passed} tests passed` };
    },
  };
}
