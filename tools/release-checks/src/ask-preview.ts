import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { describeCommand, execFailure } from './command-check.js';
import { criteriaOf, figureOfChecks, type CriterionDefinition } from './criteria.js';
import type { Check, CheckContext, CheckOutcome, CriterionResult, CheckResult, ExecRequest } from './types.js';

const ASK_EVAL = 'tools/ask-eval/data';
const SCRIPTED = 'scripted';

/** What the checks read from the repository: injected so the tests need no checkout. */
export interface Files {
  readonly readText: (path: string) => Promise<string>;
  readonly folders: (path: string) => Promise<readonly string[]>;
}

const diskFiles: Files = {
  readText: (path) => readFile(path, 'utf8'),
  folders: async (path) => (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name),
};

const scoreSchema = z.looseObject({
  model: z.string().optional(),
  refusals: z.object({ total: z.number(), refused: z.number() }),
  plans: z.object({ total: z.number(), right: z.number(), allowedMisses: z.number() }),
  scripted: z.boolean(),
  targetsMet: z.boolean(),
});

const baselineSchema = z.object({ replay: z.object({ model: z.string(), refusals: z.number(), plans: z.number() }) });

type Score = z.infer<typeof scoreSchema>;

/** The last line of the tool's output that is a JSON object: the build's own lines come before it. */
function scoreOf(output: string): Score | undefined {
  const line = [...output.split('\n')].reverse().find((candidate) => candidate.startsWith('{'));
  if (line === undefined) return undefined;
  try {
    const read = scoreSchema.safeParse(JSON.parse(line));
    return read.success ? read.data : undefined;
  } catch {
    return undefined;
  }
}

const percent = (right: number, total: number): string => `${total === 0 ? '0.0' : ((right / total) * 100).toFixed(1)}%`;

/** The reason the tool gave for a run it refused: the last line of its output that is not a build line. */
const refusalOf = (output: string): string => {
  const lines = output.split('\n').map((line) => line.trim()).filter((line) => line !== '' && !/^[\w@./-]+ (build|build\$)/.test(line) && !line.startsWith('$'));
  return lines.at(-1) ?? 'no reason given';
};

interface Measured {
  readonly status: 'passed' | 'failed';
  readonly detail: string;
  readonly figure: string;
  readonly data: Record<string, unknown>;
}

/** Judges one scoring run against its committed baseline: the tool's own targets, then the baseline's counts, which the tool does not print. */
async function measure(label: string, score: Score, baselineText: string | undefined): Promise<Measured> {
  const figure = `${label}${score.model === undefined || score.model === label ? '' : ` (${score.model})`}: refusals ${score.refusals.refused} of ${score.refusals.total}, plans ${score.plans.right} of ${score.plans.total} (${percent(score.plans.right, score.plans.total)}), at most ${score.plans.allowedMisses} may miss`;
  const failed = (detail: string): Measured => ({ status: 'failed', detail: `${label}: ${detail}`, figure, data: { label, model: score.model, refusals: score.refusals, plans: score.plans } });
  if (score.scripted) return failed('the replay is a scripted one, not a measurement');
  if (baselineText === undefined) return failed('no baseline file');
  let baselineJson: unknown;
  try {
    baselineJson = JSON.parse(baselineText);
  } catch {
    return failed('the baseline file is not valid JSON');
  }
  const baseline = baselineSchema.safeParse(baselineJson);
  if (!baseline.success) return failed('the baseline holds no value for the model');
  const held = baseline.data.replay;
  if (held.model !== score.model) return failed(`the baseline was made for ${held.model}, the replay for ${score.model ?? 'no model'}`);
  if (!score.targetsMet) return failed('the targets of the evaluation tool are not met');
  if (score.refusals.refused < held.refusals || score.plans.right < held.plans) return failed(`the counts are below the baseline (refusals ${held.refusals}, plans ${held.plans})`);
  return { status: 'passed', detail: figure, figure: `${figure}; baseline refusals ${held.refusals}, plans ${held.plans}`, data: { label, model: score.model, refusals: score.refusals, plans: score.plans, baseline: { refusals: held.refusals, plans: held.plans } } };
}

/** Runs one scoring command and reads its JSON, or says why it could not be read. */
async function scored(context: CheckContext, request: ExecRequest): Promise<{ readonly score?: Score; readonly failure?: string; readonly output: string; readonly exitCode: number | null }> {
  const result = await context.exec({ ...request, cwd: context.repoRoot });
  const score = scoreOf(result.output);
  if (score !== undefined) return { score, output: result.output, exitCode: result.exitCode };
  const failure = execFailure(result, undefined);
  return { failure: failure === undefined ? 'the output holds no score' : `${failure}: ${refusalOf(result.output)}`, output: result.output, exitCode: result.exitCode };
}

/** C1: Ask's intent scoring over the committed recording of the demo packs' questions, judged against its committed baseline. */
export function askAccuracyCheck(files: Files = diskFiles): Check {
  const request: ExecRequest = { command: 'pnpm', args: ['ask-eval', '--packs', 'domain-packs', '--replay', `${ASK_EVAL}/replay.json`, '--baseline', `${ASK_EVAL}/baseline.json`, '--json'] };
  const command = describeCommand(request);
  return {
    id: 'ask-accuracy',
    name: 'Ask intent accuracy against its baseline',
    command,
    run: async (context): Promise<CheckOutcome> => {
      const ran = await scored(context, request);
      if (ran.score === undefined) return { status: 'failed', detail: ran.failure ?? 'no score', command, exitCode: ran.exitCode, output: ran.output };
      const baselineText = await files.readText(join(context.repoRoot, ASK_EVAL, 'baseline.json')).catch(() => undefined);
      const measured = await measure('Ask', ran.score, baselineText);
      return { status: measured.status, detail: measured.detail, command, exitCode: ran.exitCode, output: ran.output, data: { ...measured.data, figure: measured.figure } };
    },
  };
}

/** C5: the assistant's route accuracy, once for each model replay committed with a folder of its own, each judged against its baseline. */
export function assistantRouteAccuracyCheck(files: Files = diskFiles): Check {
  const command = `pnpm ask-eval assistant --packs domain-packs --replay ${ASK_EVAL}/assistant/<model>/replay.json --baseline ${ASK_EVAL}/assistant/<model>/baseline.json --json`;
  return {
    id: 'assistant-route-accuracy',
    name: 'Assistant route accuracy against its baselines',
    command,
    run: async (context): Promise<CheckOutcome> => {
      const root = join(context.repoRoot, ASK_EVAL, 'assistant');
      const models = (await files.folders(root).catch(() => [] as readonly string[])).filter((name) => name !== SCRIPTED).sort();
      if (models.length === 0) return { status: 'failed', detail: 'no model replay is committed for the assistant', command, exitCode: null, output: 'no model replay\n' };
      const outputs: string[] = [];
      const measures: Measured[] = [];
      for (const model of models) {
        const request: ExecRequest = { command: 'pnpm', args: ['ask-eval', 'assistant', '--packs', 'domain-packs', '--replay', `${ASK_EVAL}/assistant/${model}/replay.json`, '--baseline', `${ASK_EVAL}/assistant/${model}/baseline.json`, '--json'] };
        const ran = await scored(context, request);
        outputs.push(ran.output);
        if (ran.score === undefined) measures.push({ status: 'failed', detail: `${model}: ${ran.failure ?? 'no score'}`, figure: `${model}: not scored`, data: { model } });
        else measures.push(await measure(model, ran.score, await files.readText(join(root, model, 'baseline.json')).catch(() => undefined)));
      }
      const failed = measures.filter((entry) => entry.status === 'failed');
      return {
        status: failed.length === 0 ? 'passed' : 'failed',
        detail: failed.length === 0 ? `${models.length} model replays meet their baselines` : failed.map((entry) => entry.detail).join('; '),
        command,
        exitCode: failed.length === 0 ? 0 : null,
        output: outputs.join(''),
        data: { models: measures.map((entry) => entry.data), figure: measures.map((entry) => entry.figure).join('; ') },
      };
    },
  };
}

/** The criteria of gate 2 that the catalogue covers so far, in the order the gate states them. */
const ASK_PREVIEW_CRITERIA: readonly CriterionDefinition[] = [
  { id: 'C1', text: 'Ask meets the targets of the evaluation tool and its committed baseline on the demo packs’ questions', checks: ['ask-accuracy'], figure: figureOfChecks(['ask-accuracy']) },
  { id: 'C5', text: 'Assistant route accuracy meets its baseline', checks: ['assistant-route-accuracy'], figure: figureOfChecks(['assistant-route-accuracy']) },
];

export const ASK_PREVIEW_CHECK_IDS = ['ask-accuracy', 'assistant-route-accuracy'] as const;

export function askPreviewCatalogue(files: Files = diskFiles): readonly Check[] {
  return [askAccuracyCheck(files), assistantRouteAccuracyCheck(files)];
}

export function askPreviewCriteria(results: readonly CheckResult[]): readonly CriterionResult[] {
  return criteriaOf(ASK_PREVIEW_CRITERIA, results);
}
