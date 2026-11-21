import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assistantSetHash, checkAssistantSets, readAssistantFile, unitsOf, type AssistantSet } from './assistant-questions.js';
import { runDefaults } from './assistant-defaults.js';
import { runLoopCost } from './assistant-loop-cost.js';
import { recordAssistant } from './assistant-record.js';
import { checkAssistantReplay, scriptedAssistantReplay, type Hooks } from './assistant-replay.js';
import { assistantReportLines, assistantResultOf } from './assistant-report.js';
import { scoreAssistantReplay } from './assistant-score.js';
import type { AssistantHooks, EvalHooks } from './hooks.js';
import { UsageError } from './questions.js';
import { parseReplay, replayProviderLines, replayText, requireModel, SCRIPTED } from './replay-file.js';
import { belowBaseline, parseBaseline, updatedBaseline } from './baseline.js';
import { requireOutsideGitTree, writePrivateFile } from './paths.js';
import { cleanUpTemporary, loadPackSource } from './sets.js';

const SET_FILE = 'assistant-questions.yaml';

/** The labelled assistant messages of every pack of a folder that has a set file, each with its Ask folder loaded as the product loads it. */
export async function loadAssistantSets(packsFolder: string, hooks: EvalHooks & AssistantHooks): Promise<AssistantSet[]> {
  const sets: AssistantSet[] = [];
  const names = readdirSync(packsFolder, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  for (const name of names) {
    const pack = join(packsFolder, name);
    if (!existsSync(join(pack, SET_FILE))) continue;
    const file = readAssistantFile(readFileSync(join(pack, SET_FILE), 'utf8'), hooks.contextTurns());
    sets.push({ label: name, source: await loadPackSource(pack, name, hooks), messages: file.messages, threads: file.threads });
  }
  if (sets.length === 0) throw new UsageError(`no pack with ${SET_FILE} was found`);
  checkAssistantSets(sets);
  return sets;
}

/** The private set of an operator: a file of messages and threads outside every repository, with the Ask folder of its source, on the terms of Ask's private set. */
async function loadPrivateAssistantSets(inputs: { readonly questions: string; readonly folder: string; readonly source: string }, hooks: Hooks): Promise<AssistantSet[]> {
  requireOutsideGitTree(inputs.questions, 'the question file');
  requireOutsideGitTree(inputs.folder, 'the folder');
  const loaded = await hooks.loadSource(inputs.folder, inputs.source);
  if (!loaded.ok) throw new UsageError(`the folder does not pass the start-up checks (${loaded.problems.length} problem${loaded.problems.length === 1 ? '' : 's'}; a private folder's problems are not printed, run the product's loader on it to see them)`);
  const file = readAssistantFile(readFileSync(inputs.questions, 'utf8'), hooks.contextTurns());
  const sets = [{ label: inputs.source, source: loaded.source, messages: file.messages, threads: file.threads }];
  checkAssistantSets(sets);
  return sets;
}

export interface AssistantArgs {
  /** A folder of packs, or the three inputs of a private set. */
  readonly packs?: string;
  readonly questions?: string;
  readonly folder?: string;
  readonly source?: string;
  readonly replay?: string;
  readonly writeReplay?: string;
  readonly baseline?: string;
  readonly updateBaseline: boolean;
  readonly json: boolean;
  readonly mode: 'score' | 'record' | 'loop-cost' | 'defaults';
  readonly runRecord?: string;
  readonly loopCost?: string;
  readonly dryRun: boolean;
  readonly budget?: string;
  readonly out?: string;
  readonly force: boolean;
  readonly resume?: boolean;
  readonly model?: string;
}

const hasAssistantHooks = (hooks: Partial<AssistantHooks>): hooks is AssistantHooks =>
  hooks.routeMessage !== undefined && hooks.routerRequests !== undefined && hooks.routerTextSha256 !== undefined && hooks.routerTextBytes !== undefined && hooks.contextKeys !== undefined && hooks.contextTurns !== undefined && hooks.assistantRunSettings !== undefined && hooks.liveAssistantProvider !== undefined && hooks.loopCostRun !== undefined && hooks.loopDefaults !== undefined && hooks.assistantLimits !== undefined;

async function setsOf(args: AssistantArgs, hooks: Hooks): Promise<{ readonly sets: AssistantSet[]; readonly privateRun: boolean }> {
  if ((args.packs === undefined) === (args.questions === undefined)) throw new UsageError('give --packs, or --questions with --folder and --source');
  if (args.packs !== undefined) {
    if (args.folder !== undefined || args.source !== undefined) throw new UsageError('--folder and --source go with --questions');
    return { sets: await loadAssistantSets(resolve(args.packs), hooks), privateRun: false };
  }
  if (args.folder === undefined || args.source === undefined) throw new UsageError('a private set needs --questions, --folder and --source');
  return { sets: await loadPrivateAssistantSets({ questions: resolve(args.questions ?? ''), folder: resolve(args.folder), source: args.source }, hooks), privateRun: true };
}

/** Scores the router over a replay of recorded replies, writes the scripted replay, or records a run; the exit code is 0 for a pass, 1 for a miss, 2 for a usage error (thrown). */
export async function runAssistant(args: AssistantArgs, io: { readonly out: (line: string) => void }, hooks: EvalHooks & Partial<AssistantHooks>, env: Readonly<Record<string, string | undefined>> = {}): Promise<number> {
  if (!hasAssistantHooks(hooks)) throw new UsageError('this build has no router to score');
  const all: Hooks = { ...hooks, routeMessage: hooks.routeMessage, routerRequests: hooks.routerRequests, routerTextSha256: hooks.routerTextSha256, routerTextBytes: hooks.routerTextBytes, contextKeys: hooks.contextKeys, contextTurns: hooks.contextTurns, assistantRunSettings: hooks.assistantRunSettings, liveAssistantProvider: hooks.liveAssistantProvider, loopCostRun: hooks.loopCostRun, loopDefaults: hooks.loopDefaults, assistantLimits: hooks.assistantLimits };
  try {
    const { sets, privateRun } = await setsOf(args, all);
    const count = unitsOf(sets).length;
    if (args.mode === 'defaults') {
      if (args.runRecord === undefined || args.loopCost === undefined) throw new UsageError('give --run-record and --loop-cost');
      const outcome = runDefaults(sets, { runRecord: args.runRecord, loopCost: args.loopCost, ...(args.out === undefined ? {} : { out: resolve(args.out) }), force: args.force }, all);
      for (const line of outcome.lines) io.out(line);
      return outcome.code;
    }
    if (args.mode === 'loop-cost') {
      const folder = args.packs !== undefined ? resolve(args.packs) : resolve(args.folder ?? '');
      const budget = args.budget === undefined ? {} : { budget: Number(args.budget) };
      const outcome = await runLoopCost(sets, { dryRun: args.dryRun, ...budget, ...(args.out === undefined ? {} : { out: resolve(args.out) }), force: args.force, folder, ...(args.model === undefined ? {} : { model: args.model }) }, all, env);
      for (const line of outcome.lines) io.out(line);
      return outcome.code;
    }
    if (args.mode === 'record') {
      const folder = args.packs !== undefined ? resolve(args.packs) : resolve(args.folder ?? '');
      const budget = args.budget === undefined ? {} : { budget: Number(args.budget) };
      const outcome = await recordAssistant(sets, { dryRun: args.dryRun, ...budget, ...(args.out === undefined ? {} : { out: resolve(args.out) }), force: args.force, resume: args.resume === true, folder, ...(args.model === undefined ? {} : { model: args.model }) }, all, env);
      for (const line of outcome.lines) io.out(line);
      return outcome.code;
    }
    if (args.writeReplay !== undefined) {
      const text = replayText(await scriptedAssistantReplay(sets, all));
      if (privateRun) {
        requireOutsideGitTree(args.writeReplay, '--write-replay');
        writePrivateFile(args.writeReplay, text, true);
      } else writeFileSync(args.writeReplay, text);
      io.out(`wrote the scripted replay of ${count} requests`);
      return 0;
    }
    if (args.replay === undefined) throw new UsageError('give --replay or --write-replay');
    if (privateRun) for (const path of [args.replay, args.baseline]) if (path !== undefined) requireOutsideGitTree(path, 'a file of a private run');
    const replay = parseReplay(readFileSync(args.replay, 'utf8'));
    requireModel(replay);
    await checkAssistantReplay(sets, replay, all);
    const result = assistantResultOf(await scoreAssistantReplay(sets, replay, all), replay.note === SCRIPTED);
    const label = `${sets.map((set) => set.label).join(', ')} (${count} requests)`;
    const hash = assistantSetHash(sets);
    let problem: string | undefined;
    if (args.baseline !== undefined) {
      const baseline = parseBaseline(readFileSync(args.baseline, 'utf8'));
      problem = belowBaseline(baseline, hash, result, replay.model);
      if (args.updateBaseline) {
        const text = `${JSON.stringify(updatedBaseline(baseline, hash, result, replay.model), null, 2)}\n`;
        if (privateRun) writePrivateFile(args.baseline, text, true);
        else writeFileSync(args.baseline, text);
        io.out('baseline written');
      }
    } else if (args.updateBaseline) throw new UsageError('--update-baseline needs --baseline');
    if (args.json) io.out(JSON.stringify({ label, ...(replay.model === undefined ? {} : { model: replay.model }), ...(replay.provider === 'local' ? { provider: 'local', grammar: replay.grammar === true, ...(replay.thinking === 'off' ? { thinking: 'off' } : {}) } : {}), ...result, questions: hash, ...(problem === undefined ? {} : { baseline: problem }) }));
    else {
      for (const line of assistantReportLines(result, label, replay.model, replayProviderLines(replay))) io.out(line);
      if (problem !== undefined) io.out(`baseline: ${problem}`);
      io.out(result.targetsMet && problem === undefined ? 'result: pass' : 'result: fail');
    }
    return result.targetsMet && problem === undefined ? 0 : 1;
  } finally {
    cleanUpTemporary();
  }
}
