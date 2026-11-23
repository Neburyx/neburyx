import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { prepareOutFolder, writePrivateFile } from '../paths.js';
import { UsageError } from '../questions.js';
import { enrichRepeat } from './enrich.js';
import { connectDb } from './db.js';
import type { Db } from './records.js';
import { runRepeat, type Http, type RepeatFile, type RepeatSettings, type TurnRecord } from './driver.js';
import { parseManifest } from './manifest.js';
import { readSettingsFile } from './settings-file.js';

const THREAD_USAGE = `usage:
  ask-eval thread records --file <run file> --database-env-file <env file> --out <file>
  ask-eval thread run --manifest <file> --base <loopback url> --settings-file <env file> --head <commit> --arm <name> [--repeats <n>] [--call-limit <n>] [--model <name>] (--dry-run | --budget <n> --out <folder>)`;

/** What a thread run needs of the outside world: the product's HTTP surface (a stand-in in tests) and the clock. */
export interface ThreadDeps {
  readonly http?: (base: string) => Http;
  readonly now?: () => number;
  /** The read-only connection to the run's own test database; absent, the real one is made from the env file. */
  readonly database?: (envFile: string) => Promise<{ readonly db: Db; readonly close: () => Promise<void> }>;
  readonly verifyFirstTurn?: (settings: RepeatSettings) => (turn: TurnRecord) => Promise<string | undefined>;
}

export interface CliIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
}

const VALUE_FLAGS = ['file', 'database-env-file', 'manifest', 'base', 'settings-file', 'head', 'arm', 'repeats', 'call-limit', 'model', 'budget', 'out'];
const REFUSED_FLAGS = ['api-key', 'key', 'token', 'password', 'secret', 'api-key-file'];

function parse(args: readonly string[]): { readonly values: Map<string, string>; readonly dryRun: boolean } {
  const values = new Map<string, string>();
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (!arg.startsWith('--')) throw new UsageError(THREAD_USAGE);
    const name = arg.slice(2);
    if (REFUSED_FLAGS.includes(name)) throw new UsageError('a provider key is never given to this command: the product reads it itself');
    if (name === 'dry-run') {
      dryRun = true;
      continue;
    }
    const value = args[index + 1];
    if (!VALUE_FLAGS.includes(name) || value === undefined || value.startsWith('--') || values.has(name)) throw new UsageError(THREAD_USAGE);
    values.set(name, value);
    index += 1;
  }
  return { values, dryRun };
}

const wholeNumber = (text: string | undefined, name: string, min: number, max: number): number | undefined => {
  if (text === undefined) return undefined;
  const value = Number(text);
  if (!Number.isInteger(value) || value < min || value > max) throw new UsageError(`--${name} is not a whole number from ${min} to ${max}`);
  return value;
};

function loopbackBase(text: string): string {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new UsageError('--base is not a URL');
  }
  const host = url.hostname;
  if (url.protocol !== 'http:' || !(host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1')) throw new UsageError('--base must be a loopback address (http://127.0.0.1 or http://localhost): the tool never reaches another machine');
  return url.origin;
}

const realHttp = (base: string): Http => async (method, path, body) => {
  const response = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  return {
    status: response.status,
    header: (name) => response.headers.get(name) ?? undefined,
    json: () => {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return undefined;
      }
    },
  };
};

/** The settings the product will use, taken from the env file it was started with; a flag that disagrees with the file is refused. */
function settingsOf(values: Map<string, string>): RepeatSettings {
  const file = readSettingsFile(resolve(values.get('settings-file') ?? ''));
  const flagLimit = wholeNumber(values.get('call-limit'), 'call-limit', 1, 10);
  const fileLimit = wholeNumber(file['NEBURYX_ASSISTANT_MAX_CALLS'], 'the settings file value of NEBURYX_ASSISTANT_MAX_CALLS', 1, 10);
  if (flagLimit !== undefined && fileLimit !== undefined && flagLimit !== fileLimit) throw new UsageError('--call-limit disagrees with the settings file');
  const callLimit = fileLimit ?? flagLimit;
  if (callLimit === undefined) throw new UsageError('the call limit is not set in the settings file: give --call-limit (the product default applies; the first turn is checked against it)');
  const flagModel = values.get('model');
  const fileModel = file['NEBURYX_ASSISTANT_MODEL'];
  if (flagModel !== undefined && fileModel !== undefined && flagModel !== fileModel) throw new UsageError('--model disagrees with the settings file');
  const model = fileModel ?? flagModel;
  if (model === undefined) throw new UsageError('the model is not set in the settings file: give --model');
  const effort = file['NEBURYX_ASK_EFFORT'];
  return { model, callLimit, ...(effort === undefined ? {} : { effort }) };
}

/** `ask-eval thread run`: one or more repeats of the thread against a running product, written as run files. Returns the exit code: 0 complete, 1 a repeat ended early, 2 usage. */
export async function runThread(argv: readonly string[], io: CliIo, deps: ThreadDeps = {}): Promise<number> {
  if (argv[0] === 'records') return await runRecords(argv.slice(1), io, deps);
  if (argv[0] !== 'run') throw new UsageError(THREAD_USAGE);
  const { values, dryRun } = parse(argv.slice(1));
  for (const name of ['manifest', 'base', 'settings-file', 'head', 'arm']) if (values.get(name) === undefined) throw new UsageError(THREAD_USAGE);
  const base = loopbackBase(values.get('base') ?? '');
  const { manifest, sha256 } = parseManifest(readFileSync(resolve(values.get('manifest') ?? ''), 'utf8'));
  const settings = settingsOf(values);
  const repeats = wholeNumber(values.get('repeats'), 'repeats', 1, 10) ?? 3;
  const mostCalls = manifest.messages.length * repeats * settings.callLimit;
  io.out(`messages: ${manifest.messages.length}`);
  io.out(`repeats: ${repeats}`);
  io.out(`arm: ${values.get('arm') ?? ''}`);
  io.out(`model: ${settings.model}`);
  io.out(`call limit: ${settings.callLimit}`);
  io.out(`most model calls: ${mostCalls}`);
  if (dryRun) return 0;
  const budget = wholeNumber(values.get('budget'), 'budget', 1, 100000);
  const out = values.get('out');
  if (budget === undefined || out === undefined) throw new UsageError(THREAD_USAGE);
  if (budget < manifest.messages.length * settings.callLimit) io.out('the budget covers less than one repeat: the run stops before a turn it cannot cover');
  if (budget < settings.callLimit) throw new UsageError('the budget is below the most calls of one turn');
  const folder = resolve(out);
  prepareOutFolder(folder);
  const http = (deps.http ?? realHttp)(base);
  const now = deps.now ?? Date.now;
  let remaining = budget;
  let incomplete = false;
  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    const file: RepeatFile = await runRepeat({ http, manifest, manifestSha256: sha256, arm: values.get('arm') ?? '', head: values.get('head') ?? '', settings, budget: remaining, now, ...(deps.verifyFirstTurn === undefined ? {} : { verifyFirstTurn: deps.verifyFirstTurn(settings) }) });
    remaining -= file.turns.length * settings.callLimit;
    writePrivateFile(resolve(folder, `thread-${values.get('arm') ?? 'arm'}-r${repeat}.json`), `${JSON.stringify(file, null, 2)}\n`, false);
    io.out(`repeat ${repeat}: ${file.turns.length} of ${manifest.messages.length} turns, ${file.ended}${file.stoppedBecause === undefined ? '' : ` (${file.stoppedBecause})`}`);
    if (file.ended !== 'complete') {
      incomplete = true;
      if (file.ended === 'budget' || file.ended === 'failed') break;
    }
  }
  return incomplete ? 1 : 0;
}

/** `ask-eval thread records`: reads the records of every turn of a run file by trace id and writes them beside it. A turn whose records are incomplete is named; no figure is made from it as if it were complete. */
async function runRecords(args: readonly string[], io: CliIo, deps: ThreadDeps): Promise<number> {
  const { values } = parse(args);
  const input = values.get('file');
  const envFile = values.get('database-env-file');
  const out = values.get('out');
  if (input === undefined || envFile === undefined || out === undefined) throw new UsageError(THREAD_USAGE);
  let file: RepeatFile;
  try {
    file = JSON.parse(readFileSync(resolve(input), 'utf8')) as RepeatFile;
  } catch {
    throw new UsageError('the run file cannot be read');
  }
  const connection = await (deps.database ?? connectDb)(resolve(envFile));
  try {
    const enriched = await enrichRepeat(file, connection.db);
    writePrivateFile(resolve(out), `${JSON.stringify(enriched, null, 2)}\n`, false);
    const incomplete = enriched.records.flatMap((entry, index) => (entry === undefined ? [`turn ${index + 1}: no trace id`] : entry.problems.map((problem) => `turn ${index + 1}: ${problem}`)));
    io.out(`turns read: ${enriched.records.filter((entry) => entry !== undefined).length} of ${file.turns.length}`);
    if (enriched.inconsistent) io.out('the settings of the runs of this repeat differ from one turn to another');
    for (const line of incomplete) io.out(line);
    return incomplete.length > 0 || enriched.inconsistent ? 1 : 0;
  } finally {
    await connection.close();
  }
}
