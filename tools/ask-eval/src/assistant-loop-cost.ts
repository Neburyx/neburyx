import { join } from 'node:path';
import { assistantSetHash, unitsOf, type AssistantSet } from './assistant-questions.js';
import { type Hooks } from './assistant-replay.js';
import type { LoopCostRun } from './hooks.js';
import { checkPrivateTarget, prepareOutFolder, requireOutsideGitTree, writePrivateFile } from './paths.js';
import { UsageError } from './questions.js';

/** One message of the run: its name, and what it cost with the loop off (steps at 1) and on (the default). */
export interface LoopCostRow {
  readonly name: string;
  readonly off: LoopCostRun;
  readonly on: LoopCostRun;
}

interface Stat {
  readonly mean: number;
  readonly median: number;
  readonly max: number;
}

const stat = (values: readonly number[]): Stat => {
  if (values.length === 0) return { mean: 0, median: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return { mean: values.reduce((sum, value) => sum + value, 0) / values.length, median: sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2, max: sorted[sorted.length - 1] ?? 0 };
};

const loopCalls = (run: LoopCostRun): number => run.total - (run.calls['assistant.route'] ?? 0);

interface RouteSummary {
  readonly route: string;
  readonly messages: number;
  readonly off: { readonly calls: Stat; readonly inputTokens: Stat; readonly outputTokens: Stat; readonly ms: Stat; readonly routerCalls: Stat; readonly otherCalls: Stat };
  readonly on: { readonly calls: Stat; readonly inputTokens: Stat; readonly outputTokens: Stat; readonly ms: Stat; readonly routerCalls: Stat; readonly otherCalls: Stat };
  readonly extra: { readonly calls: Stat; readonly inputTokens: Stat; readonly outputTokens: Stat; readonly ms: Stat };
}

export interface LoopCostSummary {
  readonly routes: readonly RouteSummary[];
  /** The messages the two runs routed differently: reported apart and left out of the extras. */
  readonly differently: readonly string[];
}

/** The summary of a run: for each route, the calls, the tokens and the time per message with the loop off and on, and the extra per routed message; the router's calls counted apart from the others. */
export function summarizeLoopCost(rows: readonly LoopCostRow[]): LoopCostSummary {
  const same = rows.filter((row) => row.off.route === row.on.route);
  const differently = rows.filter((row) => row.off.route !== row.on.route).map((row) => row.name);
  const routes = [...new Set(same.map((row) => row.off.route))].sort();
  const side = (list: readonly LoopCostRow[], pick: (row: LoopCostRow) => LoopCostRun) => ({
    calls: stat(list.map((row) => pick(row).total)),
    inputTokens: stat(list.map((row) => pick(row).inputTokens)),
    outputTokens: stat(list.map((row) => pick(row).outputTokens)),
    ms: stat(list.map((row) => pick(row).ms)),
    routerCalls: stat(list.map((row) => pick(row).calls['assistant.route'] ?? 0)),
    otherCalls: stat(list.map((row) => loopCalls(pick(row)))),
  });
  return {
    differently,
    routes: routes.map((route) => {
      const list = same.filter((row) => row.off.route === route);
      return {
        route,
        messages: list.length,
        off: side(list, (row) => row.off),
        on: side(list, (row) => row.on),
        extra: {
          calls: stat(list.map((row) => row.on.total - row.off.total)),
          inputTokens: stat(list.map((row) => row.on.inputTokens - row.off.inputTokens)),
          outputTokens: stat(list.map((row) => row.on.outputTokens - row.off.outputTokens)),
          ms: stat(list.map((row) => row.on.ms - row.off.ms)),
        },
      };
    }),
  };
}

const num = (value: number): string => (Number.isInteger(value) ? String(value) : value.toFixed(2));
const triple = (value: Stat): string => `mean ${num(value.mean)}, median ${num(value.median)}, max ${num(value.max)}`;

/** The lines of a loop-cost report: counts, tokens, times and ids only; no wording and no reply. */
export function loopCostLines(summary: LoopCostSummary, steps: number): string[] {
  const lines = [`the reads are a stand-in: a fixed result for each intent of the folder and for the view read; rows, steps and read times are not representative of a source`, `tools offered: the intents of the folder and the view read (the built-in templates are offered too, answered with the same fixed result; patterns are not offered)`, `loop off: steps 1; loop on: steps ${steps}`];
  for (const route of summary.routes) {
    lines.push(`route ${route.route}: ${route.messages} messages`);
    lines.push(`  loop off, calls per message: ${triple(route.off.calls)} (router ${triple(route.off.routerCalls)}; others ${triple(route.off.otherCalls)})`);
    lines.push(`  loop on, calls per message: ${triple(route.on.calls)} (router ${triple(route.on.routerCalls)}; others ${triple(route.on.otherCalls)})`);
    lines.push(`  extra calls per routed message: ${triple(route.extra.calls)}`);
    lines.push(`  extra input tokens: ${triple(route.extra.inputTokens)}; extra output tokens: ${triple(route.extra.outputTokens)}`);
    lines.push(`  turn time with the loop off: ${triple(route.off.ms)} ms; on: ${triple(route.on.ms)} ms; extra: ${triple(route.extra.ms)} ms`);
  }
  for (const name of summary.differently) lines.push(`routed differently in the two runs: ${name}`);
  return lines;
}

export interface LoopCostOptions {
  readonly dryRun: boolean;
  readonly budget?: number;
  readonly out?: string;
  readonly force: boolean;
  readonly folder: string;
  readonly model?: string;
}

/**
 * The cost of the tool loop on the real assistant turn: every view-route and ask-route message of the sets is run with the loop's steps at 1 and at the default, within a budget that covers, before each run, the most that run can cost.
 * The dry run makes no call and needs no key. Nothing it prints holds a wording or a reply.
 */
export async function runLoopCost(sets: readonly AssistantSet[], options: LoopCostOptions, hooks: Hooks, env: Readonly<Record<string, string | undefined>>): Promise<{ readonly lines: string[]; readonly code: number }> {
  const messages = unitsOf(sets).filter((unit) => !unit.name.includes('#') && (unit.expect.route === 'view' || unit.expect.route === 'ask'));
  const { steps, maxCalls } = hooks.loopDefaults();
  const runs = messages.length * 2;
  const settings = hooks.assistantRunSettings(env, options.model);
  if (options.dryRun) {
    return { code: 0, lines: [`messages to run: ${messages.length}, each with the loop off and on (${runs} runs)`, `calls: at most ${runs * maxCalls} (${maxCalls} for each run)`, `model: ${settings.model}`, `effort: ${settings.effort}`, `set hash: ${assistantSetHash(sets)}`] };
  }
  if (options.budget === undefined || !Number.isSafeInteger(options.budget) || options.budget < 1) throw new UsageError('a loop-cost run needs --budget, a whole number of calls');
  if (options.budget < runs * maxCalls) throw new UsageError(`the budget ${options.budget} is below the ${runs * maxCalls} calls the run may need (${maxCalls} for each of ${runs} runs)`);
  if (options.out === undefined) throw new UsageError('a loop-cost run needs --out, a folder outside every git working tree');
  requireOutsideGitTree(options.out, '--out');
  prepareOutFolder(options.out);
  checkPrivateTarget(join(options.out, 'loop-cost-record.json'), options.force);
  const live = await hooks.liveAssistantProvider(env, options.folder, options.model);
  const recording = hooks.recordingProvider(live.provider, options.budget);
  const rows: LoopCostRow[] = [];
  let stopped = false;
  let failedWith: unknown;
  try {
    for (const unit of messages) {
      // a run never starts unless the budget covers the most it can cost, so the stop never falls inside a turn
      if (options.budget - recording.usage().calls < maxCalls * 2) {
        stopped = true;
        break;
      }
      const input = { message: unit.message, viewElementKeys: unit.viewKeys };
      const off = await hooks.loopCostRun(unit.set.source, recording.provider, live.model, input, 1);
      const on = await hooks.loopCostRun(unit.set.source, recording.provider, live.model, input, steps);
      rows.push({ name: unit.name, off, on });
    }
  } catch (error) {
    failedWith = error;
  }
  const usage = recording.usage();
  const summary = summarizeLoopCost(rows);
  writePrivateFile(join(options.out, 'loop-cost-record.json'), `${JSON.stringify({ model: live.model, effort: live.effort, outputLimit: live.outputLimit, steps, maxCalls, settingsUsed: { maxCalls, maxSteps: steps, contextTurns: hooks.contextTurns(), maxInputTokens: hooks.assistantLimits().inputTokens.default }, setHash: assistantSetHash(sets), messages: messages.length, run: rows.length, stoppedAtBudget: stopped, calls: usage.calls, failedCalls: usage.failed, tokens: { input: usage.inputTokens, output: usage.outputTokens }, rows, summary }, null, 2)}\n`, options.force);
  return {
    code: stopped || failedWith !== undefined ? 1 : 0,
    lines: [
      `calls: ${usage.calls} of ${options.budget}`,
      `messages run: ${rows.length} of ${messages.length}`,
      `model: ${live.model}`,
      ...loopCostLines(summary, steps),
      ...(stopped ? ['stopped at the budget: the record holds the messages run so far'] : []),
      ...(failedWith !== undefined ? ['stopped by an unexpected error: the record holds the messages run so far'] : []),
    ],
  };
}
