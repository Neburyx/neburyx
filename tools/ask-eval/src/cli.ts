import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { belowBaseline, parseBaseline, questionsHash, updatedBaseline } from './baseline.js';
import { runAssistant } from './assistant-run.js';
import type { AssistantHooks, EvalHooks } from './hooks.js';
import { requireOutsideGitTree, writePrivateFile } from './paths.js';
import { readQuestions, UsageError } from './questions.js';
import { recordRun } from './record.js';
import { reportLines, resultOf } from './report.js';
import { checkReplay, parseReplay, replayProviderLines, replayText, requireModel, SCRIPTED, scriptedReplay } from './replay-file.js';
import { scanTree } from './scan.js';
import { scoreReplay } from './score.js';
import { runThread, type ThreadDeps } from './thread/cli.js';
import { cleanUpTemporary, loadSets, type SetInputs } from './sets.js';

export const USAGE = `usage:
  ask-eval (--packs <folder> | --questions <file> --folder <folder> --source <id>) --replay <file> [--baseline <file> [--update-baseline]] [--json]
  ask-eval (--packs <folder> | --questions <file> --folder <folder> --source <id>) --write-replay <file>
  ask-eval record (--packs <folder> | --questions <file> --folder <folder> --source <id>) (--dry-run | --budget <n> --out <folder> [--force])
  ask-eval assistant (--packs <folder> | --questions <file> --folder <folder> --source <id>) (--replay <file> [--baseline <file> [--update-baseline]] | --write-replay <file>) [--json]
  ask-eval assistant record (--packs <folder> | --questions <file> --folder <folder> --source <id>) (--dry-run | --budget <n> --out <folder> [--force | --resume]) [--model <name>]
  ask-eval assistant loop-cost (--packs <folder> | --questions <file> --folder <folder> --source <id>) (--dry-run | --budget <n> --out <folder> [--force]) [--model <name>]
  ask-eval assistant defaults (--packs <folder> | --questions <file> --folder <folder> --source <id>) --run-record <file> --loop-cost <file> [--out <folder> [--force]]
  ask-eval thread run --manifest <file> --base <loopback url> --settings-file <env file> --head <commit> --arm <name> [--repeats <n>] [--call-limit <n>] [--model <name>] (--dry-run | --budget <n> --out <folder>)
  ask-eval scan --questions <file> --folder <folder> --source <id> [--exclude <path>]... [--common <path>]... <checkout>`;

export interface CliIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
}

const VALUE_FLAGS = ['run-record', 'loop-cost', 'model', 'packs', 'questions', 'folder', 'source', 'replay', 'baseline', 'write-replay', 'budget', 'out', 'exclude', 'common'];
const SWITCHES = ['dry-run', 'force', 'json', 'resume', 'update-baseline'];

interface Parsed {
  readonly command: 'score' | 'record' | 'scan' | 'assistant';
  readonly values: Map<string, string[]>;
  readonly switches: Set<string>;
  readonly rest: string[];
}

function parse(argv: readonly string[]): Parsed {
  const command = argv[0] === 'record' || argv[0] === 'scan' || argv[0] === 'assistant' ? argv[0] : 'score';
  const args = command === 'score' ? argv : argv.slice(1);
  const values = new Map<string, string[]>();
  const switches = new Set<string>();
  const rest: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    const name = arg.startsWith('--') ? arg.slice(2) : undefined;
    if (name === undefined) {
      rest.push(arg);
      continue;
    }
    if (SWITCHES.includes(name)) {
      switches.add(name);
      continue;
    }
    const value = args[index + 1];
    if (!VALUE_FLAGS.includes(name) || value === undefined || value.startsWith('--') || (values.has(name) && name !== 'exclude' && name !== 'common')) throw new UsageError(USAGE);
    values.set(name, [...(values.get(name) ?? []), value]);
    index += 1;
  }
  return { command, values, switches, rest };
}

const one = (parsed: Parsed, name: string): string | undefined => parsed.values.get(name)?.[0];

function inputsOf(parsed: Parsed): SetInputs {
  const packs = one(parsed, 'packs');
  const questions = one(parsed, 'questions');
  if ((packs === undefined) === (questions === undefined)) throw new UsageError(USAGE);
  const folder = one(parsed, 'folder');
  const source = one(parsed, 'source');
  if (packs !== undefined && (folder !== undefined || source !== undefined)) throw new UsageError(USAGE);
  return { ...(packs === undefined ? {} : { packs: resolve(packs) }), ...(questions === undefined ? {} : { questions: resolve(questions) }), ...(folder === undefined ? {} : { folder: resolve(folder) }), ...(source === undefined ? {} : { source }) };
}

async function score(parsed: Parsed, io: CliIo, hooks: EvalHooks): Promise<number> {
  const inputs = inputsOf(parsed);
  const sets = await loadSets(inputs, hooks);
  const privateRun = inputs.packs === undefined;
  const writeTo = one(parsed, 'write-replay');
  if (writeTo !== undefined) {
    if (privateRun) {
      requireOutsideGitTree(writeTo, '--write-replay');
      writePrivateFile(writeTo, replayText(scriptedReplay(sets)), true);
    } else writeFileSync(writeTo, replayText(scriptedReplay(sets)));
    io.out(`wrote the scripted replay of ${sets.reduce((total, set) => total + set.questions.length, 0)} questions`);
    return 0;
  }
  const replayPath = one(parsed, 'replay');
  if (replayPath === undefined) throw new UsageError(USAGE);
  const baselinePath = one(parsed, 'baseline');
  if (privateRun) for (const path of [replayPath, baselinePath]) if (path !== undefined) requireOutsideGitTree(path, 'a file of a private run');
  const replay = parseReplay(readFileSync(replayPath, 'utf8'));
  requireModel(replay);
  checkReplay(sets, replay);
  const result = resultOf(await scoreReplay(sets, replay, hooks), replay.note === SCRIPTED);
  const label = `${sets.map((set) => set.label).join(', ')} (${sets.reduce((total, set) => total + set.questions.length, 0)} questions)`;
  let problem: string | undefined;
  if (baselinePath !== undefined) {
    const baseline = parseBaseline(readFileSync(baselinePath, 'utf8'));
    problem = belowBaseline(baseline, questionsHash(sets), result, replay.model);
    if (parsed.switches.has('update-baseline')) {
      const text = `${JSON.stringify(updatedBaseline(baseline, questionsHash(sets), result, replay.model), null, 2)}\n`;
      if (privateRun) writePrivateFile(baselinePath, text, true);
      else writeFileSync(baselinePath, text);
      io.out('baseline written');
    }
  } else if (parsed.switches.has('update-baseline')) throw new UsageError(USAGE);
  if (parsed.switches.has('json')) io.out(JSON.stringify({ label, ...(replay.model === undefined ? {} : { model: replay.model }), ...(replay.provider === 'local' ? { provider: 'local', grammar: replay.grammar === true, ...(replay.thinking === 'off' ? { thinking: 'off' } : {}) } : {}), ...result, questions: questionsHash(sets), ...(problem === undefined ? {} : { baseline: problem }) }));
  else {
    for (const line of reportLines(result, label, replay.model, replayProviderLines(replay))) io.out(line);
    if (problem !== undefined) io.out(`baseline: ${problem}`);
    io.out(result.targetsMet && problem === undefined ? 'result: pass' : 'result: fail');
  }
  return result.targetsMet && problem === undefined ? 0 : 1;
}

async function scan(parsed: Parsed, io: CliIo, hooks: EvalHooks): Promise<number> {
  const questionsPath = one(parsed, 'questions');
  const folder = one(parsed, 'folder');
  const source = one(parsed, 'source');
  const [checkout, ...extra] = parsed.rest;
  if (questionsPath === undefined || folder === undefined || source === undefined || checkout === undefined || extra.length > 0) throw new UsageError(USAGE);
  requireOutsideGitTree(questionsPath, 'the question file');
  requireOutsideGitTree(folder, 'the folder');
  const loaded = await hooks.loadSource(resolve(folder), source);
  if (!loaded.ok) throw new UsageError('the folder does not pass the start-up checks');
  const classification = readFileSync(resolve(folder, source, 'classification.md'), 'utf8');
  const counts = scanTree(resolve(checkout), {
    questions: readQuestions(readFileSync(resolve(questionsPath), 'utf8')).map((question) => question.wording),
    intentNames: loaded.source.intents.map((intent) => intent.name),
    classification,
    exclude: parsed.values.get('exclude') ?? [],
    common: parsed.values.get('common') ?? [],
  });
  io.out(`questions found: ${counts.questions}`);
  io.out(`intent names found: ${counts.intentNames}`);
  io.out(`classification lines found: ${counts.lines}`);
  io.out(`classification lines exempted as common: ${counts.exempted}`);
  io.out(`files skipped (over 5 MiB): ${counts.skipped}`);
  return counts.questions + counts.intentNames + counts.lines + counts.skipped === 0 ? 0 : 1;
}

async function record(parsed: Parsed, io: CliIo, hooks: EvalHooks): Promise<number> {
  const inputs = inputsOf(parsed);
  const sets = await loadSets(inputs, hooks);
  const budget = one(parsed, 'budget');
  const outcome = await recordRun(sets, { dryRun: parsed.switches.has('dry-run'), ...(budget === undefined ? {} : { budget: Number(budget) }), ...(one(parsed, 'out') === undefined ? {} : { out: resolve(one(parsed, 'out') ?? '') }), force: parsed.switches.has('force'), folder: inputs.packs ?? inputs.folder ?? '' }, hooks, io.env);
  for (const line of outcome.lines) io.out(line);
  return outcome.code;
}

/** Runs one command and returns its exit code: 0 for a pass, 1 for a miss, 2 for a usage error. A message never holds a wording, an entity value, a reply or a key. */
export async function runCli(argv: readonly string[], io: CliIo, hooks: EvalHooks & Partial<AssistantHooks>, threadDeps?: ThreadDeps): Promise<number> {
  try {
    if (argv[0] === 'thread') return await runThread(argv.slice(1), io, threadDeps);
    const parsed = parse(argv);
    if (parsed.command === 'scan') return await scan(parsed, io, hooks);
    if (parsed.command === 'record') return await record(parsed, io, hooks);
    if (parsed.command === 'assistant') {
      const path = (name: string): { readonly [key: string]: string } => (one(parsed, name) === undefined ? {} : { [name === 'write-replay' ? 'writeReplay' : name]: resolve(one(parsed, name) ?? '') });
      const plain = (name: string): { readonly [key: string]: string } => (one(parsed, name) === undefined ? {} : { [name]: one(parsed, name) ?? '' });
      return await runAssistant(
        { ...path('packs'), ...path('questions'), ...path('folder'), ...plain('source'), ...path('replay'), ...path('write-replay'), ...path('baseline'), ...plain('budget'), ...path('out'), ...plain('model'), updateBaseline: parsed.switches.has('update-baseline'), json: parsed.switches.has('json'), resume: parsed.switches.has('resume'), mode: parsed.rest[0] === 'record' ? 'record' : parsed.rest[0] === 'loop-cost' ? 'loop-cost' : parsed.rest[0] === 'defaults' ? 'defaults' : 'score', ...(one(parsed, 'run-record') === undefined ? {} : { runRecord: resolve(one(parsed, 'run-record') ?? '') }), ...(one(parsed, 'loop-cost') === undefined ? {} : { loopCost: resolve(one(parsed, 'loop-cost') ?? '') }), dryRun: parsed.switches.has('dry-run'), force: parsed.switches.has('force') },
        io,
        hooks,
        io.env,
      );
    }
    return await score(parsed, io, hooks);
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(error.message);
      return 2;
    }
    if (error instanceof Error && error.name === 'LiveProviderError') {
      io.err(error.message);
      return 2;
    }
    io.err('the command failed');
    return 1;
  } finally {
    cleanUpTemporary();
  }
}
