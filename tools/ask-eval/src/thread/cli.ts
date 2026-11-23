import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { prepareOutFolder, writePrivateFile } from '../paths.js';
import { UsageError } from '../questions.js';
import { agreement, codexRunner, countedRunner, opusRunner, parseApproval, scoreProblems, scoreSet, zeroNoAnswers, ScorerUnavailable, type Runner, type Score, type ScoreFile, type Slot } from './scorer.js';
import { blindSets, type ArmRepeat } from './blind.js';
import { enrichRepeat, type EnrichedRepeat } from './enrich.js';
import { connectDb } from './db.js';
import type { Db } from './records.js';
import { runRepeat, type Http, type RepeatFile, type RepeatSettings, type TurnRecord } from './driver.js';
import { parseManifest } from './manifest.js';
import { readSettingsFile } from './settings-file.js';

const THREAD_USAGE = `usage:
  ask-eval thread records --file <run file> --database-env-file <env file> --out <file>
  ask-eval thread score --set <file> --slots <key file> --rubric <file> --scorer (codex --approval <file> | opus --max-calls <n>) --out <file>
  ask-eval thread score --ingest <scores file> --scorer-name <name> --slots <key file> --set <file> --out <file>
  ask-eval thread calibrate --a <scores file> --b <scores file>
  ask-eval thread blind --seed <text> --sets <folder> --key <folder> <records file>...
  ask-eval thread run --manifest <file> --base <loopback url> --settings-file <env file> --head <commit> --arm <name> [--repeats <n>] [--call-limit <n>] [--model <name>] (--dry-run | --budget <n> --out <folder>)`;

/** What a thread run needs of the outside world: the product's HTTP surface (a stand-in in tests) and the clock. */
export interface ThreadDeps {
  readonly http?: (base: string) => Http;
  readonly now?: () => number;
  /** The read-only connection to the run's own test database; absent, the real one is made from the env file. */
  readonly database?: (envFile: string) => Promise<{ readonly db: Db; readonly close: () => Promise<void> }>;
  /** The scorer runners; absent, the real Codex and Opus runners. */
  readonly runners?: { readonly codex: Runner; readonly opus: Runner };
  readonly verifyFirstTurn?: (settings: RepeatSettings) => (turn: TurnRecord) => Promise<string | undefined>;
}

export interface CliIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
}

const VALUE_FLAGS = ['set', 'slots', 'rubric', 'scorer', 'approval', 'max-calls', 'ingest', 'scorer-name', 'a', 'b', 'seed', 'sets', 'key-folder', 'file', 'database-env-file', 'manifest', 'base', 'settings-file', 'head', 'arm', 'repeats', 'call-limit', 'model', 'budget', 'out'];
const REFUSED_FLAGS = ['api-key', 'key', 'token', 'password', 'secret', 'api-key-file'];

function parse(args: readonly string[], positional = false): { readonly values: Map<string, string>; readonly dryRun: boolean; readonly rest: readonly string[] } {
  const values = new Map<string, string>();
  const rest: string[] = [];
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (!arg.startsWith('--')) {
      if (!positional) throw new UsageError(THREAD_USAGE);
      rest.push(arg);
      continue;
    }
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
  return { values, dryRun, rest };
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
  if (argv[0] === 'blind') return runBlind(argv.slice(1), io);
  if (argv[0] === 'score') return await runScore(argv.slice(1), io, deps);
  if (argv[0] === 'calibrate') return runCalibrate(argv.slice(1), io);
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

/** `ask-eval thread blind`: the blind sets of the given records files (arms and repeats read from them), written to `--sets`, and the key written to a different folder `--key`. */
function runBlind(args: readonly string[], io: CliIo): number {
  const { values, rest } = parse(args, true);
  const seed = values.get('seed');
  const sets = values.get('sets');
  const keyFolder = values.get('key-folder');
  if (seed === undefined || sets === undefined || keyFolder === undefined || rest.length === 0) throw new UsageError(THREAD_USAGE);
  const setsFolder = resolve(sets);
  const keyPath = resolve(keyFolder);
  if (setsFolder === keyPath) throw new UsageError('the key folder must be another folder than the sets');
  prepareOutFolder(setsFolder);
  prepareOutFolder(keyPath);
  const inputs: ArmRepeat[] = rest.map((path) => {
    let enriched: EnrichedRepeat;
    try {
      enriched = JSON.parse(readFileSync(resolve(path), 'utf8')) as EnrichedRepeat;
    } catch {
      throw new UsageError('a records file cannot be read');
    }
    const repeat = Number(/-r(\d+)\./u.exec(path)?.[1] ?? NaN);
    if (!Number.isInteger(repeat)) throw new UsageError('a records file name must end in -r<repeat>.records.json');
    return { arm: enriched.file.arm, repeat, enriched };
  });
  const forbidden = [...new Set(inputs.flatMap((entry) => [entry.arm, entry.enriched.file.manifest.name, entry.enriched.file.settings.model, entry.enriched.file.head, ...entry.enriched.file.turns.flatMap((turn) => (turn.traceId === undefined ? [] : [turn.traceId]))]))];
  const output = blindSets(inputs, { seed, manifestSha256: inputs[0]?.enriched.file.manifest.sha256 ?? '', forbidden });
  for (const [repeat, text] of output.sets) writePrivateFile(resolve(setsFolder, `set-${repeat}.md`), text, false);
  writePrivateFile(resolve(keyPath, 'key.json'), `${JSON.stringify({ key: output.key, slots: output.slots }, null, 2)}\n`, false);
  io.out(`sets written: ${output.sets.size}`);
  io.out(`answers to score: ${output.slots.length}`);
  return 0;
}

const readJson = (path: string, what: string): unknown => {
  try {
    return JSON.parse(readFileSync(resolve(path), 'utf8')) as unknown;
  } catch {
    throw new UsageError(`${what} cannot be read`);
  }
};

/** The slots of a set the generator wrote as no answer: they score zero on every criterion whatever a scorer says. */
function noAnswerSlots(set: string, repeat: number): Set<string> {
  const found = new Set<string>();
  let turn = 0;
  let label = '';
  for (const line of set.split('\n')) {
    const turnMatch = /^## Turn (\d+)$/u.exec(line);
    if (turnMatch !== null) turn = Number(turnMatch[1]);
    const labelMatch = /^### Answer ([A-D])$/u.exec(line);
    if (labelMatch !== null) label = labelMatch[1] ?? '';
    if (line.startsWith('(no answer:') && label !== '') found.add(`${repeat}/${turn}/${label}`);
  }
  return found;
}

/** `ask-eval thread score`: scores one blind set with the named scorer, or ingests scores made elsewhere; the scores are validated against the exact slots of the set. */
async function runScore(args: readonly string[], io: CliIo, deps: ThreadDeps): Promise<number> {
  const { values } = parse(args);
  const setPath = values.get('set');
  const slotsPath = values.get('slots');
  const out = values.get('out');
  if (setPath === undefined || slotsPath === undefined || out === undefined) throw new UsageError(THREAD_USAGE);
  const set = readFileSync(resolve(setPath), 'utf8');
  const repeat = Number(/^# Set (\d+)/u.exec(set)?.[1] ?? NaN);
  if (!Number.isInteger(repeat)) throw new UsageError('the set file is not a blind set');
  const slotsFile = readJson(slotsPath, 'the slots file');
  const slots = ((typeof slotsFile === 'object' && slotsFile !== null ? (slotsFile as { slots?: Slot[] }).slots : undefined) ?? []).filter((slot) => slot.repeat === repeat);
  if (slots.length === 0) throw new UsageError('the slots file holds no slot of this set');
  const none = noAnswerSlots(set, repeat);
  let file: ScoreFile;
  const ingest = values.get('ingest');
  if (ingest !== undefined) {
    const name = values.get('scorer-name');
    if (name === undefined) throw new UsageError(THREAD_USAGE);
    const parsed = readJson(ingest, 'the scores file') as { scores?: Score[] };
    file = { scorer: name, origin: 'ingested', scores: zeroNoAnswers(parsed.scores ?? [], none) };
  } else {
    const rubricPath = values.get('rubric');
    const scorer = values.get('scorer');
    if (rubricPath === undefined || (scorer !== 'codex' && scorer !== 'opus')) throw new UsageError(THREAD_USAGE);
    const runners = deps.runners ?? { codex: codexRunner(), opus: opusRunner() };
    let limit: number;
    if (scorer === 'codex') {
      const approvalPath = values.get('approval');
      const approval = approvalPath === undefined ? undefined : parseApproval(readFileSync(resolve(approvalPath), 'utf8'));
      if (approval === undefined) {
        io.err('Codex is not invoked: the approver\'s written confirmation of the exception to the live-call rule and the approved number of invocations are required (--approval)');
        return 2;
      }
      limit = approval.invocations;
    } else {
      const max = wholeNumber(values.get('max-calls'), 'max-calls', 1, 100);
      if (max === undefined) throw new UsageError('--scorer opus needs --max-calls');
      limit = max;
    }
    const counted = countedRunner(runners[scorer], limit);
    let scores: Score[];
    try {
      scores = await scoreSet(counted.run, readFileSync(resolve(rubricPath), 'utf8'), set, slots, `set ${repeat}`);
    } catch (error) {
      if (error instanceof ScorerUnavailable) {
        io.err(error.message);
        return 1;
      }
      io.err(error instanceof Error ? error.message : 'the scorer failed');
      return 1;
    }
    file = { scorer, origin: 'harness', invocations: counted.made(), scores: zeroNoAnswers(scores, none) };
  }
  const problems = scoreProblems(slots, file.scores);
  if (problems.length > 0) {
    for (const problem of problems.slice(0, 5)) io.err(problem);
    return 1;
  }
  writePrivateFile(resolve(out), `${JSON.stringify(file, null, 2)}\n`, false);
  io.out(`scores written: ${file.scores.length} by ${file.scorer} (${file.origin}${file.invocations === undefined ? '' : `, ${file.invocations} invocations`})`);
  return 0;
}

/** `ask-eval thread calibrate`: the agreement of two scorers on the same set. */
function runCalibrate(args: readonly string[], io: CliIo): number {
  const { values } = parse(args);
  const a = values.get('a');
  const b = values.get('b');
  if (a === undefined || b === undefined) throw new UsageError(THREAD_USAGE);
  const result = agreement((readJson(a, 'the first scores file') as ScoreFile).scores, (readJson(b, 'the second scores file') as ScoreFile).scores);
  io.out(`slots compared: ${result.slots}`);
  io.out(`agreement: C1 ${result.c1.toFixed(1)}% · C2 ${result.c2.toFixed(1)}% · C3 ${result.c3.toFixed(1)}% · C4 ${result.c4.toFixed(1)}% · overall ${result.overall.toFixed(1)}%`);
  io.out(result.indicative ? 'indicative: the overall agreement is below 90 percent' : 'the agreement is at or above 90 percent');
  return 0;
}
