import { join } from 'node:path';
import { questionsHash } from './baseline.js';
import type { EvalHooks } from './hooks.js';
import { UsageError } from './questions.js';
import { checkPrivateTarget, prepareOutFolder, requireOutsideGitTree, writePrivateFile } from './paths.js';
import { replayText, type Replay } from './replay-file.js';
import type { SourceSet } from './sets.js';

export interface RecordOptions {
  readonly dryRun: boolean;
  readonly budget?: number;
  readonly out?: string;
  readonly force: boolean;
  /** The folder whose absolute path stands for the settings of Ask during the run. */
  readonly folder: string;
}

const count = (sets: readonly SourceSet[]): number => sets.reduce((total, set) => total + set.questions.length, 0);

/**
 * A recording run: exactly one call for each question, never more than the budget, counted before it is made. The dry run makes no call and needs no key.
 * Returns the lines to print and the exit code; nothing it prints holds a question, a reply or a key.
 */
export async function recordRun(sets: readonly SourceSet[], options: RecordOptions, hooks: EvalHooks, env: Readonly<Record<string, string | undefined>>): Promise<{ readonly lines: string[]; readonly code: number }> {
  const questions = count(sets);
  const planned = hooks.plannedSettings(env);
  if (options.dryRun) {
    return {
      code: 0,
      lines: [
        `questions to ask: ${questions}`,
        `calls: ${questions}`,
        `model: ${planned.model}`,
        `effort: ${planned.effort}`,
        ...sets.map((set) => `prompt hash ${set.label}: ${set.source.classificationSha256}`),
        `questions hash: ${questionsHash(sets)}`,
      ],
    };
  }
  if (options.budget === undefined || !Number.isSafeInteger(options.budget) || options.budget < 1) throw new UsageError('a recording run needs --budget, a whole number of calls');
  if (options.budget < questions) throw new UsageError(`the budget ${options.budget} is below the ${questions} calls the run needs`);
  if (options.out === undefined) throw new UsageError('a recording run needs --out, a folder outside every git working tree');
  requireOutsideGitTree(options.out, '--out');
  prepareOutFolder(options.out);
  for (const name of ['recording.json', 'run-record.json']) checkPrivateTarget(join(options.out, name), options.force);
  const live = await hooks.liveProvider(env, options.folder);
  const recording = hooks.recordingProvider(live.provider, options.budget);
  let stopped = false;
  let failedWith: unknown;
  try {
    for (const set of sets) {
      for (const question of set.questions) {
        if (recording.usage().calls >= options.budget) {
          stopped = true;
          break;
        }
        await hooks.classify(set.source, recording.provider, live.model, question.wording);
      }
      if (stopped) break;
    }
  } catch (error) {
    failedWith = error;
  }
  const usage = recording.usage();
  const replay: Replay = { folders: Object.fromEntries(sets.map((set) => [set.source.sourceId, set.source.classificationSha256])), answers: Object.fromEntries(recording.answers()) };
  const record = { model: live.model, effort: live.effort, prompts: Object.fromEntries(sets.map((set) => [set.label, set.source.classificationSha256])), questions, questionsHash: questionsHash(sets), stoppedAtBudget: stopped, stoppedByError: failedWith !== undefined, ...usage };
  writePrivateFile(join(options.out, 'recording.json'), replayText(replay), options.force);
  writePrivateFile(join(options.out, 'run-record.json'), `${JSON.stringify(record, null, 2)}\n`, options.force);
  return {
    code: stopped || failedWith !== undefined ? 1 : 0,
    lines: [
      `calls: ${usage.calls} of ${options.budget}`,
      `model: ${live.model}`,
      `effort: ${live.effort}`,
      ...sets.map((set) => `prompt hash ${set.label}: ${set.source.classificationSha256}`),
      `tokens: in ${usage.inputTokens}, out ${usage.outputTokens}, cache read ${usage.cacheReadTokens}, cache write ${usage.cacheWriteTokens}, calls without counts ${usage.withoutCounts}`,
      `failed calls: ${usage.failed}`,
      ...(stopped ? ['stopped at the budget: the recording holds the questions answered so far'] : []),
      ...(failedWith !== undefined ? ['stopped by an unexpected error: the recording holds the questions answered so far'] : []),
    ],
  };
}
