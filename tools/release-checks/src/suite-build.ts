import { describeCommand, execFailure } from './command-check.js';
import type { CheckContext, Exec, ExecRequest } from './types.js';

/** What a suite test imports is built output (`dist` is not in git), and the summary suite's own tests need its build too, so a run on a commit must build before it measures that commit, as the root `test` script does. */
const BUILDS: readonly ExecRequest[] = [
  { command: 'pnpm', args: ['build:deps'] },
  { command: 'pnpm', args: ['--filter', '@neburyx/summary-suite', 'build'] },
];

export interface BuildOutcome {
  readonly ok: boolean;
  readonly detail: string;
  readonly command: string;
  readonly exitCode: number | null;
  readonly output: string;
}

const done = new WeakMap<Exec, Promise<BuildOutcome>>();

async function build(context: CheckContext): Promise<BuildOutcome> {
  const outputs: string[] = [];
  for (const request of BUILDS) {
    const result = await context.exec({ ...request, cwd: context.repoRoot });
    outputs.push(result.output);
    const failure = execFailure(result, undefined);
    if (failure !== undefined) return { ok: false, detail: `build failed: ${failure} (${describeCommand(request)})`, command: describeCommand(request), exitCode: result.exitCode, output: outputs.join('') };
  }
  return { ok: true, detail: 'built', command: BUILDS.map(describeCommand).join(' && '), exitCode: 0, output: outputs.join('') };
}

/** Builds once for the whole run, whichever check asks first; a failed build is the answer every later asker gets. */
export function builtOnce(context: CheckContext): Promise<BuildOutcome> {
  const known = done.get(context.exec);
  if (known !== undefined) return known;
  const started = build(context);
  done.set(context.exec, started);
  return started;
}
