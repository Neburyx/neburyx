import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { AI_DEFAULTS, SUMMARY_DEFAULTS } from '@neburyx/contracts';
import { checkPrivateTarget, prepareOutFolder, requireOutsideGitTree, writePrivateFile } from '../paths.js';
import { UsageError } from '../questions.js';
import { factsOf } from './facts.js';
import { c5Of, checkBars, textDecision, unblind, validateKey } from './report.js';
import { agreement, codexRunner, countedRunner, opusRunner, parseApproval, scoreProblems, scoreSet, zeroNoAnswers, ScorerUnavailable, type Runner } from './scorer.js';
import { parseBars, parseCalibration, parseEnriched, parseIngested, parseKeyFile, parseLedger, parsePrices, parseRepeatFile, parseScoreFile, type Calibration, type Score, type ScoreFile } from './schemas.js';
import { blindSets, type ArmRepeat } from './blind.js';
import { readTurnRecords, type Waiting } from './records.js';
import { enrichRepeat } from './enrich.js';
import { connectDb } from './db.js';
import type { Db } from './records.js';
import { runRepeat, type Http, type RepeatFile, type RepeatSettings, type TurnRecord } from './driver.js';
import { parseManifest } from './manifest.js';
import { readSettingsFile, type AllowedName } from './settings-file.js';

const THREAD_USAGE = `usage:
  ask-eval thread records --file <run file> --database-env-file <env file> --allowed-tools <a,b,...> [--non-gate-tools <a,b,...>] --out <file>
  ask-eval thread score --set <file> --slots <key file> --rubric <file> --scorer (codex --approval <file> | opus --max-calls <n>) --out <file>
  ask-eval thread score --ingest <scores file> --scorer-name <name> --slots <key file> --set <file> --out <file>
  ask-eval thread report --key-file <key file> --bars <file> --primary <scorer> --product <arm> --evidence <records file>,... [--calibrations <file>,...] [--text-arm <arm>] <scores file>...
  ask-eval thread facts [--call-limit <n>] [--prices <file>] <records file>...
  ask-eval thread calibrate --key-file <key file> --a <scores file> --b <scores file> --out <file>
  ask-eval thread blind --seed <text> --sets <folder> --key-folder <another folder> <records file>...
  ask-eval thread run --manifest <file> --base <loopback url> --settings-file <env file> --head <commit> --arm <name> [--repeats <n>] [--call-limit <n>] [--model <name>] (--dry-run | --budget <n> --out <folder> --database-env-file <env file>)`;

/** What a thread run needs of the outside world: the product's HTTP surface (a stand-in in tests) and the clock. */
export interface ThreadDeps {
  readonly http?: (base: string) => Http;
  readonly now?: () => number;
  /** The read-only connection to the run's own test database; absent, the real one is made from the env file. */
  readonly database?: (envFile: string) => Promise<{ readonly db: Db; readonly close: () => Promise<void> }>;
  readonly runners?: { readonly codex: Runner; readonly opus: Runner };
  /** How long the records of a turn are waited for; absent, a bounded real wait. */
  readonly waiting?: Waiting;
  readonly verifyFirstTurn?: (settings: RepeatSettings) => (turn: TurnRecord) => Promise<string | undefined>;
}

export interface CliIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
}

const VALUE_FLAGS = ['prices', 'key-file', 'bars', 'primary', 'product', 'calibrations', 'evidence', 'text-arm', 'set', 'slots', 'rubric', 'scorer', 'approval', 'max-calls', 'ingest', 'scorer-name', 'a', 'b', 'seed', 'sets', 'key-folder', 'file', 'allowed-tools', 'non-gate-tools', 'database-env-file', 'manifest', 'base', 'settings-file', 'head', 'arm', 'repeats', 'call-limit', 'model', 'budget', 'out'];
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

const ARM = /^[A-Za-z0-9][A-Za-z0-9._-]{1,39}$/u;
const CREDENTIAL = [/sk-[A-Za-z0-9_-]{16,}/u, /\b(?:postgres(?:ql)?|bolt(?:\+s)?|neo4j(?:\+s)?|mongodb|redis|mysql):\/\/\S+/iu, /\bset-cookie\b|\bcookie:\s|"(?:set-)?cookie"\s*:|"authorization"\s*:/iu, /-----BEGIN [A-Z ]*PRIVATE KEY-----/u, /\bAKIA[0-9A-Z]{16}\b/u, /\bBearer\s+[A-Za-z0-9._-]{20,}/u];

const looksLikeCredential = (text: string): boolean => CREDENTIAL.some((pattern) => pattern.test(text));

/** A file's text is written only when it holds nothing that looks like a credential; the refusal names no content. */
function writeChecked(path: string, text: string, replace: boolean): void {
  if (looksLikeCredential(text)) throw new UsageError('the content holds credential-like text: it is not written');
  requireOutsideGitTree(path, 'an output file');
  writePrivateFile(path, text, replace);
}

/** Every line the tool prints passes the same check: a line that looks like a credential is replaced by a fixed notice, so a value of the product or a scorer never reaches the terminal as such. */
function guarded(io: CliIo): CliIo {
  const safe = (line: string): string => (looksLikeCredential(line) ? '[a line that looked like a credential was withheld]' : line);
  return { out: (line) => io.out(safe(line)), err: (line) => io.err(safe(line)), env: io.env };
}

/** A file to write is checked before any paid work: not a link, not there already, outside every git tree, and in a folder that exists and can be written. */
function preflightTarget(path: string, replace = false): void {
  checkPrivateTarget(path, replace);
  requireOutsideGitTree(path, 'an output file');
  const folder = dirname(path);
  try {
    if (!statSync(folder).isDirectory()) throw new UsageError('the folder of an output file is not a folder');
    accessSync(folder, constants.W_OK);
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError('the folder of an output file does not exist or cannot be written');
  }
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

const REQUEST_TIMEOUT_MS = 180_000;

/** The real HTTP: a bounded time for every request, and a redirect is an error (the tool never leaves the loopback origin it checked). */
const realHttp = (base: string): Http => async (method, path, body) => {
  const response = await fetch(`${base}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  return {
    status: response.status,
    header: (name) => response.headers.get(name) ?? undefined,
    json: () => {
      try {
        const parsed: unknown = JSON.parse(text);
        return parsed;
      } catch {
        return undefined;
      }
    },
  };
};

/** The numeric allowlisted settings of the file and the key the run record holds each under. */
const NUMERIC_SETTINGS: readonly (readonly [AllowedName, string])[] = [['NEBURYX_ASSISTANT_TIMEOUT_MS', 'timeoutMs'], ['NEBURYX_ASSISTANT_TOTAL_TIMEOUT_MS', 'totalTimeoutMs'], ['NEBURYX_ASSISTANT_MAX_STEPS', 'maxSteps'], ['NEBURYX_ASSISTANT_MAX_ROWS', 'maxRows'], ['NEBURYX_ASSISTANT_CONTEXT_TURNS', 'contextTurns'], ['NEBURYX_ASSISTANT_MAX_MESSAGE_WORDS', 'maxMessageWords'], ['NEBURYX_ASSISTANT_MAX_INPUT_TOKENS', 'maxInputTokens'], ['NEBURYX_ASSISTANT_MAX_OUTPUT_TOKENS', 'maxOutputTokens']];

/** The settings the product will use: the file's value, else the product's default; a flag that disagrees with that effective value is refused. The effort says where it came from. */
function settingsOf(values: Map<string, string>, defaults: { readonly maxCalls: number } | undefined): RepeatSettings {
  const file = readSettingsFile(resolve(values.get('settings-file') ?? ''));
  const flagLimit = wholeNumber(values.get('call-limit'), 'call-limit', 1, 10);
  const fileLimit = wholeNumber(file['NEBURYX_ASSISTANT_MAX_CALLS'], 'the settings file value of NEBURYX_ASSISTANT_MAX_CALLS', 1, 10);
  const callLimit = fileLimit ?? defaults?.maxCalls;
  if (callLimit === undefined) throw new UsageError('the call limit is not set in the settings file and the product default is not known to this build');
  if (flagLimit !== undefined && flagLimit !== callLimit) throw new UsageError('--call-limit disagrees with the settings the product will use');
  const flagModel = values.get('model');
  const model = file['NEBURYX_ASSISTANT_MODEL'] ?? SUMMARY_DEFAULTS.model;
  if (flagModel !== undefined && flagModel !== model) throw new UsageError('--model disagrees with the settings the product will use');
  const fileEffort = file['NEBURYX_ASK_EFFORT'];
  const configured: Record<string, string | number> = {};
  for (const [name, key] of NUMERIC_SETTINGS) {
    const value = wholeNumber(file[name], `the settings file value of ${name}`, 1, 10_000_000);
    if (value !== undefined) configured[key] = value;
  }
  if (file['NEBURYX_ASSISTANT_MODEL'] !== undefined) configured['model'] = model;
  if (fileLimit !== undefined) configured['maxCalls'] = callLimit;
  return { model, callLimit, configured, effort: fileEffort ?? AI_DEFAULTS.effort, effortSource: fileEffort === undefined ? 'the product default' : 'the settings file', modelSource: file['NEBURYX_ASSISTANT_MODEL'] === undefined ? 'the product default' : 'the settings file' };
}

/** `ask-eval thread run`: one or more repeats of the thread against a running product, written as run files. Returns the exit code: 0 complete, 1 a repeat ended early, 2 usage. */
export async function runThread(argv: readonly string[], rawIo: CliIo, deps: ThreadDeps = {}, defaults?: { readonly maxCalls: number }): Promise<number> {
  const io = guarded(rawIo);
  if (argv[0] === 'records') return await runRecords(argv.slice(1), io, deps);
  if (argv[0] === 'blind') return runBlind(argv.slice(1), io);
  if (argv[0] === 'score') return await runScore(argv.slice(1), io, deps);
  if (argv[0] === 'calibrate') return runCalibrate(argv.slice(1), io);
  if (argv[0] === 'report') return runReport(argv.slice(1), io);
  if (argv[0] === 'facts') return runFacts(argv.slice(1), io);
  if (argv[0] !== 'run') throw new UsageError(THREAD_USAGE);
  const { values, dryRun } = parse(argv.slice(1));
  for (const name of ['manifest', 'base', 'settings-file', 'head', 'arm']) if (values.get(name) === undefined) throw new UsageError(THREAD_USAGE);
  const armName = values.get('arm') ?? '';
  if (!ARM.test(armName)) throw new UsageError('--arm must be 2 to 40 letters, digits, dots, dashes or underscores, starting with a letter or digit');
  const base = loopbackBase(values.get('base') ?? '');
  const { manifest, sha256 } = parseManifest(readFileSync(resolve(values.get('manifest') ?? ''), 'utf8'));
  const settings = settingsOf(values, defaults);
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
  const databaseEnvFile = values.get('database-env-file');
  if (budget === undefined || out === undefined || (databaseEnvFile === undefined && deps.verifyFirstTurn === undefined)) throw new UsageError(THREAD_USAGE);
  if (budget < manifest.messages.length * settings.callLimit) io.out('the budget covers less than one repeat: the run stops before a turn it cannot cover');
  if (budget < settings.callLimit) throw new UsageError('the budget is below the most calls of one turn');
  const folder = resolve(out);
  prepareOutFolder(folder);
  // every file this run will write is checked before any request: a link, an existing file or a place inside a git tree stops it with no call made
  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    const target = resolve(folder, `thread-${armName}-r${repeat}.json`);
    preflightTarget(target);
  }
  const http = (deps.http ?? realHttp)(base);
  const now = deps.now ?? Date.now;
  let remaining = budget;
  let incomplete = false;
  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    const file: RepeatFile = await runRepeat({ http, manifest, manifestSha256: sha256, repeat, arm: values.get('arm') ?? '', head: values.get('head') ?? '', settings, budget: remaining, now, verifyFirstTurn: deps.verifyFirstTurn === undefined ? firstTurnVerifier(deps, resolve(databaseEnvFile ?? ''), settings) : deps.verifyFirstTurn(settings) });
    remaining -= file.turns.length * settings.callLimit;
    writeChecked(resolve(folder, `thread-${armName}-r${repeat}.json`), `${JSON.stringify(file, null, 2)}\n`, false);
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
  const allowedTools = (values.get('allowed-tools') ?? '').split(',').filter((name) => name !== '');
  if (input === undefined || envFile === undefined || out === undefined || allowedTools.length === 0) throw new UsageError(THREAD_USAGE);
  const file: RepeatFile = parseRepeatFile(readJson(input, 'the run file'), 'the run file');
  const target = resolve(out);
  preflightTarget(target);
  const connection = await (deps.database ?? connectDb)(resolve(envFile));
  try {
    const waiting = deps.waiting ?? { attempts: RECORD_WAITS, delayMs: RECORD_WAIT_MS, sleep: (ms: number) => new Promise<void>((done) => setTimeout(done, ms)) };
    const enriched = await enrichRepeat(file, connection.db, { allowedTools, withoutGate: (values.get('non-gate-tools') ?? 'answer,view').split(',').filter((name) => name !== ''), waiting });
    writeChecked(resolve(out), `${JSON.stringify(enriched, null, 2)}\n`, false);
    const incomplete = enriched.records.flatMap((entry, index) => (entry === undefined ? [`turn ${index + 1}: no trace id`] : entry.problems.map((problem) => `turn ${index + 1}: ${problem}`)));
    enriched.evidence.forEach((entry, index) => {
      if (entry === undefined) return;
      const gate = entry.gate;
      for (const [piece, verdict] of [['reads through the gate', gate.gated.verdict], ['tools called', gate.called.verdict], ['tools offered', gate.offered.verdict]] as const) if (verdict !== 'passed') incomplete.push(`turn ${index + 1}: ${piece} ${verdict}`);
      if (entry.citations.missing.length > 0) incomplete.push(`turn ${index + 1}: cited keys with no line: ${entry.citations.missing.join(', ')}`);
      if (entry.citations.malformed > 0) incomplete.push(`turn ${index + 1}: ${entry.citations.malformed} malformed citations`);
    });
    io.out(`turns read: ${enriched.records.filter((entry) => entry !== undefined).length} of ${file.turns.length}`);
    if (enriched.inconsistent) io.out('the settings of the runs of this repeat differ from one turn to another');
    for (const line of incomplete) io.out(line);
    return incomplete.length > 0 || enriched.inconsistent ? 1 : 0;
  } finally {
    await connection.close();
  }
}

/** `ask-eval thread blind`: the blind sets of the given records files (arms and repeats read from them), written to `--sets`, and the key written to a different folder `--key-folder`. */
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
    const enriched = parseEnriched(readJson(path, 'a records file'), 'a records file');
    return { arm: enriched.file.arm, repeat: enriched.file.repeat, enriched };
  });
  const names = rest.flatMap((path) => [path, basename(path), basename(path).replace(/\.[^.]*$/u, '')]);
  const runIds = inputs.flatMap((entry) => entry.enriched.records.flatMap((records) => (records?.run === undefined || records.run.id === '' ? [] : [records.run.id])));
  const forbidden = [...new Set([...names, ...runIds, ...inputs.flatMap((entry) => [entry.arm, entry.enriched.file.manifest.name, entry.enriched.file.settings.model, entry.enriched.file.head, ...entry.enriched.file.turns.flatMap((turn) => (turn.traceId === undefined ? [] : [turn.traceId]))])])];
  const output = blindSets(inputs, { seed, manifestSha256: inputs[0]?.enriched.file.manifest.sha256 ?? '', forbidden });
  for (const [repeat, text] of output.sets) writeChecked(resolve(setsFolder, `set-${repeat}.md`), text, false);
  writeChecked(resolve(keyPath, 'key.json'), `${JSON.stringify({ key: output.key, slots: output.slots }, null, 2)}\n`, false);
  io.out(`sets written: ${output.sets.size}`);
  io.out(`answers to score: ${output.slots.length}`);
  return 0;
}

const readJson = (path: string, what: string): unknown => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(resolve(path), 'utf8'));
    return parsed;
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

const sha256Of = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** The calls of an approval already used, kept in a file beside it, so that one approval is spent once across sets, retries and commands. */
function ledgerPath(approvalPath: string): string {
  return `${resolve(approvalPath)}.ledger.json`;
}

function usedUnderApproval(approvalPath: string): number {
  const path = ledgerPath(approvalPath);
  return existsSync(path) ? parseLedger(readJson(path, 'the approval ledger'), 'the approval ledger').used : 0;
}

const LOCK_TRIES = 100;
const LOCK_WAIT_MS = 20;
const STALE_LOCK_MS = 30_000;

/** Takes one invocation of the approval before a launch: under a lock folder made exclusively, so two commands cannot take the same one, the used count is read, checked against the approval and written back. */
function reserveInvocation(approvalPath: string, approved: number): void {
  const lock = `${ledgerPath(approvalPath)}.lock`;
  for (let attempt = 1; ; attempt += 1) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      break;
    } catch {
      if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) rmSync(lock, { recursive: true, force: true });
      else if (attempt >= LOCK_TRIES) throw new ScorerUnavailable('the approval ledger is locked by another command');
      else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_WAIT_MS);
    }
  }
  try {
    const used = usedUnderApproval(approvalPath);
    if (used >= approved) throw new ScorerUnavailable('the approved number of invocations is used up');
    writePrivateFile(ledgerPath(approvalPath), `${JSON.stringify({ used: used + 1 })}\n`, true);
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** `ask-eval thread score`: scores one blind set with the named scorer, or ingests scores made elsewhere; the scores are validated against the exact slots of the set and carry the set's hash. */
async function runScore(args: readonly string[], io: CliIo, deps: ThreadDeps): Promise<number> {
  const { values } = parse(args);
  const setPath = values.get('set');
  const slotsPath = values.get('slots');
  const out = values.get('out');
  if (setPath === undefined || slotsPath === undefined || out === undefined) throw new UsageError(THREAD_USAGE);
  const target = resolve(out);
  preflightTarget(target);
  const set = readFileSync(resolve(setPath), 'utf8');
  const repeat = Number(/^# Set (\d+)/u.exec(set)?.[1] ?? NaN);
  if (!Number.isInteger(repeat)) throw new UsageError('the set file is not a blind set');
  const key = parseKeyFile(readJson(slotsPath, 'the key file'), 'the key file');
  const setSha256 = sha256Of(set);
  if (key.key.sets[String(repeat)] !== setSha256) throw new UsageError('the set file is not the set the key was made with');
  const slots = key.slots.filter((slot) => slot.repeat === repeat);
  const none = noAnswerSlots(set, repeat);
  let file: ScoreFile;
  const ingest = values.get('ingest');
  if (ingest !== undefined) {
    const name = values.get('scorer-name');
    if (name === undefined) throw new UsageError(THREAD_USAGE);
    const ingested = parseIngested(readJson(ingest, 'the scores file'), 'the scores file');
    file = { scorer: name, origin: 'ingested', repeat, setSha256, scores: zeroNoAnswers(ingested.scores, none) };
  } else {
    const rubricPath = values.get('rubric');
    const scorer = values.get('scorer');
    if (rubricPath === undefined || (scorer !== 'codex' && scorer !== 'opus')) throw new UsageError(THREAD_USAGE);
    const runners = deps.runners ?? { codex: codexRunner(), opus: opusRunner() };
    const rubric = readFileSync(resolve(rubricPath), 'utf8');
    if (looksLikeCredential(rubric) || looksLikeCredential(set)) throw new UsageError('the rubric or the set holds credential-like text: it is not sent to a scorer');
    let limit: number;
    let reserve: (() => void) | undefined;
    const approvalPath = values.get('approval');
    if (scorer === 'codex') {
      const approval = approvalPath === undefined ? undefined : parseApproval(readFileSync(resolve(approvalPath), 'utf8'));
      if (approval === undefined || approvalPath === undefined) {
        io.err('Codex is not invoked: the approver\'s written confirmation of the exception to the live-call rule and the approved number of invocations are required (--approval)');
        return 2;
      }
      preflightTarget(ledgerPath(approvalPath), true);
      limit = approval.invocations - usedUnderApproval(approvalPath);
      reserve = () => reserveInvocation(approvalPath, approval.invocations);
      if (limit < 1) {
        io.err('Codex is not invoked: the approved number of invocations is used up');
        return 2;
      }
    } else {
      const max = wholeNumber(values.get('max-calls'), 'max-calls', 1, 100);
      if (max === undefined) throw new UsageError('--scorer opus needs --max-calls');
      limit = max;
    }
    const counted = countedRunner(runners[scorer], limit, reserve);
    let scores: Score[];
    try {
      scores = await scoreSet(counted.run, rubric, set, slots, `set ${repeat}`);
    } catch (error) {
      io.err(error instanceof Error ? error.message : 'the scorer failed');
      return 1;
    }
    file = { scorer, origin: 'harness', repeat, setSha256, invocations: counted.made(), scores: zeroNoAnswers(scores, none) };
  }
  const problems = scoreProblems(slots, file.scores);
  if (problems.length > 0) {
    for (const problem of problems.slice(0, 5)) io.err(problem);
    return 1;
  }
  writeChecked(target, `${JSON.stringify(file, null, 2)}\n`, false);
  io.out(`scores written: ${file.scores.length} by ${file.scorer} (${file.origin}${file.invocations === undefined ? '' : `, ${file.invocations} calls`})`);
  return 0;
}

/** `ask-eval thread calibrate`: the agreement of two scorers on the same complete set, written as the artifact the report requires to count or mark another scorer's repeats. */
function runCalibrate(args: readonly string[], io: CliIo): number {
  const { values } = parse(args);
  const a = values.get('a');
  const b = values.get('b');
  const keyPath = values.get('key-file');
  const out = values.get('out');
  if (a === undefined || b === undefined || keyPath === undefined || out === undefined) throw new UsageError(THREAD_USAGE);
  const target = resolve(out);
  preflightTarget(target);
  const key = parseKeyFile(readJson(keyPath, 'the key file'), 'the key file');
  const first = parseScoreFile(readJson(a, 'the first scores file'), 'the first scores file');
  const second = parseScoreFile(readJson(b, 'the second scores file'), 'the second scores file');
  if (first.scorer === second.scorer) throw new UsageError('the two scores files are of the same scorer');
  if (first.repeat !== second.repeat || first.setSha256 !== second.setSha256) throw new UsageError('the two scores files are not for the same set');
  if (key.key.sets[String(first.repeat)] !== first.setSha256) throw new UsageError('the scores are not for a set of this key');
  const slots = key.slots.filter((slot) => slot.repeat === first.repeat);
  for (const file of [first, second]) {
    const problems = scoreProblems(slots, file.scores);
    if (problems.length > 0) throw new UsageError(`the scores of ${file.scorer} do not cover the set exactly: ${problems[0] ?? ''}`);
  }
  const result = agreement(first.scores, second.scores);
  const artifact: Calibration = { repeat: first.repeat, setSha256: first.setSha256, scorers: [first.scorer, second.scorer], slots: result.slots, agreement: { overall: result.overall, c1: result.c1, c2: result.c2, c3: result.c3, c4: result.c4 }, indicative: result.indicative };
  writeChecked(target, `${JSON.stringify(artifact, null, 2)}\n`, false);
  io.out(`slots compared: ${result.slots}`);
  io.out(`agreement: C1 ${result.c1.toFixed(1)}% · C2 ${result.c2.toFixed(1)}% · C3 ${result.c3.toFixed(1)}% · C4 ${result.c4.toFixed(1)}% · overall ${result.overall.toFixed(1)}%`);
  io.out(result.indicative ? 'indicative: the overall agreement is below 90 percent' : 'the agreement is at or above 90 percent');
  return 0;
}

/** `ask-eval thread report`: the scores unblinded, the bars checked and the text decision taken. Exit 0 when every figure is at or above its bar, 1 when the feature stays open. */
function runReport(args: readonly string[], io: CliIo): number {
  const { values, rest } = parse(args, true);
  const keyPath = values.get('key-file');
  const barsPath = values.get('bars');
  const primary = values.get('primary');
  const product = values.get('product');
  if (keyPath === undefined || barsPath === undefined || primary === undefined || product === undefined || rest.length === 0) throw new UsageError(THREAD_USAGE);
  if (primary !== 'codex') throw new UsageError('the primary scorer is codex: the bar is judged on its repeats');
  const key = parseKeyFile(readJson(keyPath, 'the key file'), 'the key file');
  const bars = parseBars(readJson(barsPath, 'the bars file'), 'the bars file');
  validateKey(key, bars);
  const files = rest.map((path) => parseScoreFile(readJson(path, 'a scores file'), 'a scores file'));
  const calibrations = (values.get('calibrations') ?? '').split(',').filter((path) => path !== '').map((path) => parseCalibration(readJson(path, 'a calibration file'), 'a calibration file'));
  const arms = unblind(files, key, calibrations, primary);
  for (const arm of arms) {
    io.out(`arm ${arm.arm}: ${arm.repeats.map((entry) => `repeat ${entry.repeat} ${entry.total}${entry.indicative ? ' (indicative)' : ''}${entry.counted ? '' : ' (not counted)'}`).join(', ')}; median ${arm.median ?? 'none'}; counts C1 ${arm.criteria.c1} C2 ${arm.criteria.c2} C3 ${arm.criteria.c3} C4 ${arm.criteria.c4}`);
  }
  const evidencePaths = (values.get('evidence') ?? '').split(',').filter((path) => path !== '');
  const c5 = evidencePaths.length === 0 ? undefined : c5Of(evidencePaths.map((path) => parseEnriched(readJson(path, 'an evidence file'), 'an evidence file')));
  const report = checkBars(arms, product, bars, c5);
  for (const line of report.lines) io.out(line);
  for (const finding of report.findings) io.out(`finding: ${finding.bar}: ${finding.figure}: ${finding.kind}: ${finding.where}`);
  io.out(`decision: ${textDecision(arms, product, values.get('text-arm'))}`);
  return report.status === 'met' ? 0 : 1;
}

/** `ask-eval thread facts`: calls, tokens, time and cost per turn and per run from the records files; exit 1 when any figure is incomplete (printed, never hidden). */
function runFacts(args: readonly string[], io: CliIo): number {
  const { values, rest } = parse(args, true);
  const limit = wholeNumber(values.get('call-limit'), 'call-limit', 1, 10);
  if (rest.length === 0) throw new UsageError(THREAD_USAGE);
  const pricesPath = values.get('prices');
  const prices = pricesPath === undefined ? undefined : parsePrices(readJson(pricesPath, 'the prices file'), 'the prices file');
  const facts = factsOf(rest.map((path) => parseEnriched(readJson(path, 'a records file'), 'a records file')), { ...(limit === undefined ? {} : { callLimit: limit }), ...(prices === undefined ? {} : { prices }) });
  for (const turn of facts.turns) io.out(`repeat ${turn.repeat} turn ${turn.turn}: calls ${turn.calls ?? 'unknown'}, tokens in ${turn.inputTokens ?? 'unknown'} out ${turn.outputTokens ?? 'unknown'} cache read ${turn.cacheReadTokens ?? 'unknown'} write ${turn.cacheWriteTokens ?? 'unknown'}, ${turn.ms} ms${turn.cost === undefined ? '' : `, cost ${turn.cost.toFixed(4)}`}`);
  io.out(`calls per turn: mean ${facts.callsMean?.toFixed(2) ?? 'none'}, median ${facts.callsMedian ?? 'none'}, p95 ${facts.callsP95 ?? 'none'}; median time ${facts.medianMs ?? 'none'} ms`);
  io.out(facts.p95Verdict);
  if (facts.turnsAtLimit.length > 0) io.out(`turns that used the whole limit: ${facts.turnsAtLimit.join(', ')}`);
  if (facts.totalCost !== undefined) io.out(`cost of the run: ${facts.totalCost.toFixed(4)} (prices of ${prices?.date ?? ''})`);
  for (const line of facts.incomplete) io.out(`incomplete: ${line}`);
  io.out(facts.evidence ? 'accepted as evidence' : 'not accepted as evidence');
  return facts.evidence ? 0 : 1;
}

const RECORD_WAITS = 12;
const RECORD_WAIT_MS = 1000;
const FIRST_TURN_WAITS = 10;
const FIRST_TURN_WAIT_MS = 500;

/** After the first turn: its run record, read by trace id (the record is written without blocking the answer, so it is waited for a bounded time), must show the model and the call limit that were verified before the run. */
function firstTurnVerifier(deps: ThreadDeps, envFile: string, settings: RepeatSettings): (turn: TurnRecord) => Promise<string | undefined> {
  return async (turn) => {
    if (turn.traceId === undefined) return 'the first turn has no trace id: its run record cannot be checked';
    const connection = await (deps.database ?? connectDb)(envFile);
    try {
      for (let attempt = 1; attempt <= FIRST_TURN_WAITS; attempt += 1) {
        const records = await readTurnRecords(connection.db, turn.traceId);
        if (records.run !== undefined) {
          const shown = records.run.settings;
          if (shown['model'] !== settings.model) return 'the run record of the first turn shows another model than the settings file';
          if (shown['maxCalls'] !== settings.callLimit) return 'the run record of the first turn shows another call limit than the settings file';
          for (const [key, value] of Object.entries(settings.configured)) if (shown[key] !== value) return `the run record of the first turn shows another ${key} than the settings file`;
          return undefined;
        }
        await new Promise((done) => setTimeout(done, FIRST_TURN_WAIT_MS));
      }
      return 'the run record of the first turn was not found in time';
    } finally {
      await connection.close();
    }
  };
}
