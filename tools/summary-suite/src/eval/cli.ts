import type { EvalHooks } from './hooks.js';
import type { MeasureMode } from './manifest.js';
import { UsageError } from './paths.js';
import { runEvaluation, type RunOptions } from './run.js';

export interface Io {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Aborted when the person stops the run: the click in flight ends cancelled, no further view is run, and the report is still printed. */
  readonly signal?: AbortSignal;
}

const USAGE = [
  'usage: summary-eval [--stub | --budget <n> --out <folder> --folder <ask folder>] [--dry-run] [--views all|demo|aml|<id,id>] [--measure | --measure-only] [--json] [--force]',
  '  --stub     answer every view with its own labelled sentences: no key, no network, no model call',
  '  --dry-run  make no call: print what a run can cost',
  '  --measure  also measure the size of the text sent (the views and the samples of 10, 100 and the element cap, plain, with short properties and with long ones) against the tokens the provider counts; --measure-only measures and does not score',
  '  a live run needs NEBURYX_ASK_API_KEY_FILE in the environment; a measuring run also needs NEBURYX_SUMMARY_MAX_INPUT_TOKENS of at least 136000, or the long-property samples are refused and nothing is proposed',
];

function parse(args: readonly string[]): RunOptions {
  let stub = false;
  let measure: MeasureMode = 'none';
  let dryRun = false;
  let budget: number | undefined;
  let views = 'all';
  let json = false;
  let out: string | undefined;
  let force = false;
  let folder: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = (): string => {
      const next = args[index + 1];
      if (next === undefined) throw new UsageError(`${arg} needs a value`);
      index += 1;
      return next;
    };
    if (arg === '--stub') stub = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--measure') measure = measure === 'only' ? 'only' : 'add';
    else if (arg === '--measure-only') measure = 'only';
    else if (arg === '--json') json = true;
    else if (arg === '--force') force = true;
    else if (arg === '--budget') {
      const text = value();
      if (!/^\d+$/u.test(text)) throw new UsageError('--budget is a whole number of calls');
      budget = Number(text);
    } else if (arg === '--views') views = value();
    else if (arg === '--out') out = value();
    else if (arg === '--folder') folder = value();
    else throw new UsageError(`unknown argument ${arg ?? ''}`);
  }
  return { stub, measure, dryRun, ...(budget === undefined ? {} : { budget }), views, json, ...(out === undefined ? {} : { out }), force, ...(folder === undefined ? {} : { folder }) };
}

/** Runs the command; returns the exit code: 0 for a run that finished within its budget, 1 for one that did not, 2 for a usage error. */
export async function runCli<Provider>(args: readonly string[], io: Io, hooks: EvalHooks<Provider>): Promise<number> {
  try {
    const result = await runEvaluation(parse(args), hooks, io.env, io.signal);
    for (const line of result.lines) io.out(line);
    return result.code;
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(error.message);
      for (const line of USAGE) io.err(line);
      return 2;
    }
    throw error;
  }
}
