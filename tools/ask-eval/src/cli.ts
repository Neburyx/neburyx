import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { checkExternalRun, checkOnePack, ExternalFileError, isDemoFile, isInsideCheckout } from './external.js';
import { countWordingHits } from './scan.js';
import { loadMapping, MappingBudgetError } from './mapping-view.js';
import { loadQuestions, QuestionFileError, type Question } from './questions.js';
import { loadReplay, ReplayFileError } from './replay.js';
import { replayFromQuestions } from './replay-writer.js';
import { BASELINE_MODES, BaselineError, loadBaseline, updateBaseline, valueOf, type BaselineMode } from './baseline.js';
import { groupLines, groupReport } from './groups.js';
import { summarize } from './report.js';
import { DEMO_MAX_PLAN_MISSES, tally } from './targets.js';
import { DuplicateQuestionTextError, runQuestions, type Target } from './run.js';
import type { PlannerModule, Replay } from './types.js';

class UsageError extends Error {}

export const EXIT_OK = 0;
export const EXIT_MISS = 1;
export const EXIT_USAGE = 2;

const MAPPING_FILE = 'neburyx.yaml';
const USAGE = 'usage: ask-eval --questions <file> --replay <file> (--packs <folder> | --mapping <file>) [--write-replay [--force]] [--baseline <file> --mode replay|live [--update-baseline]] [--max-misses <n>] [--json]';

export interface CliIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

const OPTIONS = {
  questions: { type: 'string' },
  replay: { type: 'string' },
  mapping: { type: 'string' },
  packs: { type: 'string' },
  'write-replay': { type: 'boolean' },
  force: { type: 'boolean' },
  baseline: { type: 'string' },
  mode: { type: 'string' },
  'update-baseline': { type: 'boolean' },
  'max-misses': { type: 'string' },
  json: { type: 'boolean' },
  out: { type: 'string' },
  'refusal-target': { type: 'string' },
  root: { type: 'string' },
} as const;

function mappingPathOf(question: Question, packs: string | undefined, mapping: string | undefined): string {
  if (packs !== undefined && question.pack !== undefined) return join(packs, question.pack, MAPPING_FILE);
  if (mapping !== undefined) return mapping;
  throw new UsageError(`the question ${question.id} has no pack to find a mapping for, and no --mapping was given`);
}

async function buildTargets(questions: readonly Question[], module: PlannerModule, replay: Replay, packs: string | undefined, mapping: string | undefined): Promise<(question: Question) => Target> {
  const byPath = new Map<string, Target>();
  for (const question of questions) {
    const path = mappingPathOf(question, packs, mapping);
    if (byPath.has(path)) continue;
    const loaded = loadMapping(path);
    byPath.set(path, { planner: await module.createEvalPlanner({ view: loaded.view, replay }), context: loaded.context });
  }
  return (question) => {
    const target = byPath.get(mappingPathOf(question, packs, mapping));
    if (target === undefined) throw new UsageError('a mapping was not loaded');
    return target;
  };
}

function outPath(value: string | undefined): string {
  if (value === undefined || isInsideCheckout(value)) throw new UsageError('--out must name a path outside the checkout');
  return value;
}

function modeOf(value: string | undefined): BaselineMode {
  const mode = BASELINE_MODES.find((candidate) => candidate === (value ?? 'replay'));
  if (mode === undefined) throw new UsageError('--mode is replay or live');
  return mode;
}

function maxMissesOf(value: string | undefined): number {
  if (value === undefined) return DEMO_MAX_PLAN_MISSES;
  if (!/^[0-9]+$/.test(value)) throw new UsageError('--max-misses is a whole number');
  return Number(value);
}

async function runScan(argv: readonly string[], io: CliIo): Promise<number> {
  try {
    const { values } = parseArgs({ args: [...argv], options: { questions: { type: 'string' }, root: { type: 'string' } }, strict: true });
    if (values.questions === undefined || values.root === undefined) throw new UsageError('scan needs --questions and --root');
    io.out(String(countWordingHits(values.questions, values.root)));
    return EXIT_OK;
  } catch (error) {
    if (error instanceof QuestionFileError || error instanceof UsageError || error instanceof TypeError) {
      io.err(error instanceof TypeError ? 'usage: ask-eval scan --questions <file> --root <folder>' : error.message);
      return EXIT_USAGE;
    }
    throw error;
  }
}

function writeReplay(path: string, replay: Replay, force: boolean): void {
  const text = `${JSON.stringify(Object.fromEntries(Object.entries(replay).sort(([left], [right]) => left.localeCompare(right))), null, 2)}\n`;
  if (existsSync(path) && readFileSync(path, 'utf8') !== text && !force) throw new UsageError('the replay file exists and differs; --force replaces it');
  writeFileSync(path, text);
}

export async function runCli(argv: readonly string[], io: CliIo, module: PlannerModule): Promise<number> {
  if (argv[0] === 'scan') return runScan(argv.slice(1), io);
  let values;
  try {
    ({ values } = parseArgs({ args: [...argv], options: OPTIONS, strict: true }));
  } catch {
    io.err(USAGE);
    return EXIT_USAGE;
  }
  const { questions: questionsPath, replay: replayPath, mapping, packs } = values;
  if (questionsPath === undefined || replayPath === undefined || (mapping === undefined && packs === undefined)) {
    io.err(USAGE);
    return EXIT_USAGE;
  }
  try {
    checkExternalRun({ questions: questionsPath, out: values.out, writes: values['write-replay'] === true || values['update-baseline'] === true, maxMisses: values['max-misses'], packs, mapping, refusalTarget: values['refusal-target'] });
    const questions = loadQuestions(questionsPath);
    if (!isDemoFile(questionsPath)) checkOnePack(questions);
    const external = !isDemoFile(questionsPath);
    if (values['write-replay'] === true) {
      const targetOf = await buildTargets(questions, module, {}, packs, mapping);
      writeReplay(external ? outPath(values.out) : replayPath, replayFromQuestions(questions, (question) => targetOf(question).planner.rebuild(question.wording)), values.force === true);
      io.out(external ? 'replay written' : `replay written: ${replayPath}`);
      return EXIT_OK;
    }
    const targetOf = await buildTargets(questions, module, loadReplay(replayPath), packs, mapping);
    const results = await runQuestions(questions, targetOf);
    const found = tally(questions, results);
    const mode = modeOf(values.mode);
    const baseline = values.baseline === undefined ? undefined : loadBaseline(values.baseline, questions);
    const summary = summarize(found, results, maxMissesOf(values['max-misses']), mode, baseline?.modes[mode]);
    const report = groupReport(questions, results, summary.data);
    if (values.json === true) io.out(JSON.stringify(report));
    else for (const line of [...summary.lines, ...groupLines(report)]) io.out(line);
    if (values['update-baseline'] === true) {
      if (values.baseline === undefined) throw new UsageError('--update-baseline needs --baseline');
      if (!summary.met) throw new UsageError('the baseline is written only by a run that meets its targets');
      updateBaseline(external ? outPath(values.out) : values.baseline, questions, mode, found);
      (values.json === true ? io.err : io.out)(`baseline written for the mode ${mode}: plans ${valueOf(found).plansRight}, refusals ${valueOf(found).refusalsRefused}`);
    }
    return summary.met ? EXIT_OK : EXIT_MISS;
  } catch (error) {
    if (error instanceof QuestionFileError || error instanceof ReplayFileError || error instanceof MappingBudgetError || error instanceof DuplicateQuestionTextError || error instanceof UsageError || error instanceof BaselineError || error instanceof ExternalFileError) {
      io.err(error.message);
      return EXIT_USAGE;
    }
    throw error;
  }
}
