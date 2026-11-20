import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EvalHooks, SourceHandle } from './hooks.js';
import { readQuestions, UsageError, type Question } from './questions.js';
import { requireOutsideGitTree } from './paths.js';

/** The questions of one source and its loaded folder. `label` is what a report calls the source: a pack's name, or the source id of a private set. */
export interface SourceSet {
  readonly label: string;
  readonly source: SourceHandle;
  readonly questions: readonly Question[];
}

export interface SetInputs {
  readonly packs?: string;
  readonly questions?: string;
  readonly folder?: string;
  readonly source?: string;
}

const SOURCE_ID = /^ {2}- id: (\S+)/m;
const temporary: string[] = [];

/** Removes the temporary folders the packs were copied to for the run. */
export function cleanUpTemporary(): void {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
}

/** The Ask folder of one pack, copied to a temporary folder in the shape the product loads and loaded as the product loads it. */
export async function loadPackSource(pack: string, name: string, hooks: EvalHooks): Promise<SourceHandle> {
  if (!existsSync(join(pack, 'ask'))) throw new UsageError(`the pack ${name} has no ask folder`);
  const id = SOURCE_ID.exec(readFileSync(join(pack, 'neburyx.yaml'), 'utf8'))?.[1];
  if (id === undefined) throw new UsageError(`the pack ${name} names no source id`);
  const root = mkdtempSync(join(tmpdir(), 'ask-eval-'));
  temporary.push(root);
  mkdirSync(join(root, id));
  cpSync(join(pack, 'ask'), join(root, id), { recursive: true });
  const loaded = await hooks.loadSource(root, id);
  if (!loaded.ok) throw new UsageError(`the ask folder of the pack ${name} does not pass the start-up checks: ${loaded.problems.join('; ')}`);
  return loaded.source;
}

async function demoSets(packsFolder: string, hooks: EvalHooks): Promise<SourceSet[]> {
  const sets: SourceSet[] = [];
  const names = readdirSync(packsFolder, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  for (const name of names) {
    const pack = join(packsFolder, name);
    if (!existsSync(join(pack, 'questions.yaml')) && !existsSync(join(pack, 'ask'))) continue;
    if (!existsSync(join(pack, 'questions.yaml')) || !existsSync(join(pack, 'ask'))) throw new UsageError(`the pack ${name} needs both questions.yaml and an ask folder`);
    sets.push({ label: name, source: await loadPackSource(pack, name, hooks), questions: readQuestions(readFileSync(join(pack, 'questions.yaml'), 'utf8')) });
  }
  if (sets.length === 0) throw new UsageError('no pack with questions and an ask folder was found');
  return sets;
}

async function privateSet(inputs: SetInputs, hooks: EvalHooks): Promise<SourceSet[]> {
  const { questions, folder, source } = inputs;
  if (questions === undefined || folder === undefined || source === undefined) throw new UsageError('a private set needs --questions, --folder and --source');
  requireOutsideGitTree(questions, 'the question file');
  requireOutsideGitTree(folder, 'the folder');
  const loaded = await hooks.loadSource(folder, source);
  if (!loaded.ok) throw new UsageError(`the folder does not pass the start-up checks (${loaded.problems.length} problem${loaded.problems.length === 1 ? '' : 's'}; a private folder's problems are not printed, run the product's loader on it to read them)`);
  return [{ label: source, source: loaded.source, questions: readQuestions(readFileSync(questions, 'utf8')) }];
}

/** Loads the sets of a run and checks them against their folders, so that no question can be unanswerable for a reason that is the file's. */
export async function loadSets(inputs: SetInputs, hooks: EvalHooks): Promise<SourceSet[]> {
  const sets = inputs.packs === undefined ? await privateSet(inputs, hooks) : await demoSets(inputs.packs, hooks);
  const wordings = new Set<string>();
  const ids = new Set<string>();
  for (const set of sets) {
    for (const question of set.questions) {
      const name = `${set.label}/${question.id}`;
      if (ids.has(name)) throw new UsageError(`the id ${name} is used twice`);
      ids.add(name);
      if (wordings.has(question.wording)) throw new UsageError(`the wording of ${name} is used by another question of the set`);
      wordings.add(question.wording);
      const expected = question.expect;
      if (expected === 'refuse') continue;
      const intent = set.source.intents.find((candidate) => candidate.name === expected.intent);
      if (intent === undefined) throw new UsageError(`the question ${name} expects an intent that the folder does not have`);
      const given = Object.keys(expected.entities).sort().join('\u0000');
      if (given !== [...intent.parameters].sort().join('\u0000')) throw new UsageError(`the question ${name} expects entities that are not exactly the parameters of its intent`);
    }
  }
  return sets;
}
