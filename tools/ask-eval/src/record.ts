import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { isDemoFile, isInsideCheckout } from './external.js';
import { loadMapping } from './mapping-view.js';
import { loadQuestions, QuestionFileError, type Question } from './questions.js';
import type { Ledger, PlannerModule, Recorder, Replay, RunRecord } from './types.js';

class RecordUsageError extends Error {}

export const RECORDING_FILE = 'recording.json';
const OPTIONS = { questions: { type: 'string' }, mapping: { type: 'string' }, packs: { type: 'string' }, budget: { type: 'string' }, out: { type: 'string' }, 'dry-run': { type: 'boolean' }, model: { type: 'string' }, ai: { type: 'string' }, force: { type: 'boolean' } } as const;
const USAGE = 'usage: ask-eval record --questions <file> (--packs <folder> | --mapping <file>) (--dry-run | --budget <n> --out <folder outside the checkout>) [--ai <file outside the checkout>] [--model <name>] [--force]';
const MAPPING_FILE = 'neburyx.yaml';

export interface RecordIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

function mappingPathOf(question: Question, packs: string | undefined, mapping: string | undefined): string {
  if (packs !== undefined && question.pack !== undefined) return join(packs, question.pack, MAPPING_FILE);
  if (mapping !== undefined) return mapping;
  throw new RecordUsageError(`the question ${question.id} has no pack to find a mapping for, and no --mapping was given`);
}

function budgetOf(value: string | undefined): number {
  if (value === undefined || !/^[1-9][0-9]*$/.test(value)) throw new RecordUsageError('--budget is a whole number of at least 1');
  return Number(value);
}

function sorted(replay: Replay): string {
  return `${JSON.stringify(Object.fromEntries(Object.entries(replay).sort(([left], [right]) => left.localeCompare(right))), null, 2)}\n`;
}

/** The lines of a run record: counts, the model and the prompt versions, never a wording or a reply. */
export function recordLines(run: RunRecord, asked: number): string[] {
  const lines = [`recorded: ${run.recorded} of ${asked} questions`, `calls: ${run.calls} of ${run.budget}`];
  if (run.stoppedByBudget) lines.push('stopped: the call budget was reached');
  for (const failure of run.failures) lines.push(`failed: ${failure.id} (${failure.code})`);
  lines.push(`model: ${run.model}`, `prompts: ${run.prompts.map((prompt) => `${prompt.id}@${prompt.version}`).join(', ')}`, `list: ${run.listVersion}`);
  lines.push(`tokens: in ${run.tokens.in}, out ${run.tokens.out}, cache read ${run.tokens.cacheRead}, cache write ${run.tokens.cacheWrite}, calls without counts ${run.tokens.callsWithoutCounts}`);
  return lines;
}

/** `ask-eval record`: asks the questions of a file through the real planner over a provider, never past the budget, and writes the replies as a replay outside the checkout. */
export async function runRecord(argv: readonly string[], io: RecordIo, module: PlannerModule): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({ args: [...argv], options: OPTIONS, strict: true }));
  } catch {
    io.err(USAGE);
    return 2;
  }
  try {
    const { questions: questionsPath, mapping, packs } = values;
    if (questionsPath === undefined || (mapping === undefined && packs === undefined)) throw new RecordUsageError(USAGE);
    if (!isDemoFile(questionsPath)) {
      if (isInsideCheckout(questionsPath)) throw new RecordUsageError('a question file inside the checkout other than the demo file is refused');
      if (packs !== undefined || mapping === undefined) throw new RecordUsageError('an external question file takes one --mapping and no --packs');
    }
    const questions = loadQuestions(questionsPath);
    const asked = questions.filter((question) => question.expect.kind !== 'blocked');
    if (values['dry-run'] === true) {
      io.out(`questions to ask: ${asked.length}`);
      io.out(`expected blocked, not asked: ${questions.length - asked.length}`);
      io.out(`worst case calls: ${asked.length * 2}`);
      return 0;
    }
    const budget = budgetOf(values.budget);
    if (values.out === undefined || isInsideCheckout(values.out)) throw new RecordUsageError('--out must name a folder outside the checkout');
    if (values.ai !== undefined && isInsideCheckout(values.ai)) throw new RecordUsageError('--ai must name a file outside the checkout');
    const file = join(values.out, RECORDING_FILE);
    if (existsSync(file) && values.force !== true) throw new RecordUsageError('the recording exists; --force replaces it');
    const recording = module.recording;
    if (recording === undefined) throw new RecordUsageError('this build has no provider for a recording run');
    const mappings = new Set(asked.map((question) => mappingPathOf(question, packs, mapping)));
    const [first] = [...mappings];
    if (first === undefined) throw new RecordUsageError('there is no question to ask');
    let built;
    try {
      built = await recording.provider({ mapping: first, ai: values.ai, model: values.model });
    } catch (error) {
      throw new RecordUsageError(error instanceof Error ? error.message : 'the provider could not be built');
    }
    const { provider, model } = built;
    const ledger: Ledger = recording.createLedger(budget, model);
    const recorders = new Map<string, Recorder>();
    for (const path of mappings) recorders.set(path, await recording.createRecorder({ view: loadMapping(path).view, provider, ledger }));
    let stopped = false;
    let crashed = false;
    const blocked: string[] = [];
    for (const question of asked) {
      const recorder = recorders.get(mappingPathOf(question, packs, mapping));
      if (recorder === undefined) throw new RecordUsageError('a mapping was not loaded');
      try {
        const outcome = await recorder.record(question.id, question.wording);
        if (outcome === 'blocked') blocked.push(question.id);
        if (outcome === 'stopped') {
          stopped = true;
          break;
        }
      } catch {
        crashed = true;
        break;
      }
    }
    const replay: Replay = Object.assign({}, ...[...recorders.values()].map((recorder) => recorder.replay()));
    mkdirSync(values.out, { recursive: true });
    writeFileSync(file, sorted(replay), { mode: 0o600 });
    chmodSync(file, 0o600);
    const run = ledger.run();
    for (const line of recordLines(run, asked.length)) io.out(line);
    for (const id of blocked) io.out(`blocked: ${id}`);
    if (crashed) io.err('the run ended on an unexpected error; the recording holds the questions answered before it');
    return crashed || stopped || run.failures.length > 0 || run.recorded < asked.length ? 1 : 0;
  } catch (error) {
    if (error instanceof RecordUsageError || error instanceof QuestionFileError) {
      io.err(error.message);
      return 2;
    }
    throw error;
  }
}
