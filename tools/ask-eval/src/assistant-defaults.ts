import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { unitsOf, type AssistantSet } from './assistant-questions.js';
import type { Hooks } from './assistant-replay.js';
import { checkPrivateTarget, prepareOutFolder, requireOutsideGitTree, writePrivateFile } from './paths.js';
import { UsageError } from './questions.js';

/** The share of a limit above which an observed maximum is called close to it: the division's working figure. */
const CLOSE = 0.8;
/** The margin a proposed value keeps over the observed maximum: the division's working figure. */
const MARGIN = 1.25;

type Verdict = 'inside' | 'close' | 'over' | 'not measured';

export interface Observed {
  readonly count: number;
  readonly max: number;
  readonly p95: number;
  readonly p99: number;
}

export interface Finding {
  readonly setting: string;
  readonly observed: Observed;
  readonly default: number;
  readonly highest: number;
  readonly verdict: Verdict;
  /** The same observed maximum judged against the highest value the setting accepts. */
  readonly ceilingVerdict: Verdict;
  readonly proposed?: number;
  readonly reason: string;
}

/** The value at a rank of the sorted values, by the nearest-rank rule. */
function rank(sorted: readonly number[], share: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(share * sorted.length) - 1))] ?? 0;
}

export function observe(values: readonly number[]): Observed {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: values.length, max: sorted[sorted.length - 1] ?? 0, p95: rank(sorted, 0.95), p99: rank(sorted, 0.99) };
}

/** Inside, close (the maximum is over 80% of the limit a turn runs under) or over; a proposed value keeps a 25% margin over the maximum, within the highest value the setting accepts. */
export function judge(setting: string, observed: Observed, limit: { readonly default: number; readonly highest: number }, note?: string): Finding {
  const ceilingVerdict: Verdict = observed.count === 0 ? 'not measured' : observed.max > limit.highest ? 'over' : observed.max > limit.highest * CLOSE ? 'close' : 'inside';
  const base = { setting, observed, default: limit.default, highest: limit.highest, ceilingVerdict };
  if (observed.count === 0) return { ...base, verdict: 'not measured', reason: note ?? 'no observation' };
  if (observed.max > limit.default) return { ...base, verdict: 'over', proposed: Math.min(limit.highest, Math.ceil(observed.max * MARGIN)), reason: `the observed maximum ${observed.max} is over the default ${limit.default}; the proposal keeps a 25% margin, within the highest value ${limit.highest}` };
  if (observed.max > limit.default * CLOSE) return { ...base, verdict: 'close', proposed: Math.min(limit.highest, Math.ceil(observed.max * MARGIN)), reason: `the observed maximum ${observed.max} is over 80% of the default ${limit.default}` };
  return { ...base, verdict: 'inside', reason: note ?? `the observed maximum ${observed.max} is inside the default ${limit.default}` };
}

const outcomeSchema = z.object({ name: z.string(), status: z.string(), calls: z.number(), inputTokens: z.number(), outputTokens: z.number() });
const runRecordSchema = z.object({ outcomes: z.array(outcomeSchema) });
const rowSchema = z.object({ name: z.string(), on: z.object({ total: z.number(), inputTokens: z.number(), outputTokens: z.number(), stepCalls: z.number(), steps: z.number(), maxInputTokens: z.number(), maxOutputTokens: z.number(), rows: z.number() }) });
const loopRecordSchema = z.object({ rows: z.array(rowSchema) });

function parseRecord<T>(text: string, schema: z.ZodType<T>, what: string): T {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new UsageError(`the ${what} is not valid JSON`);
  }
  const read = schema.safeParse(data);
  if (!read.success) throw new UsageError(`the ${what} is not in the expected form`);
  return read.data;
}

const wordsOf = (text: string): number => text.trim().split(/\s+/).filter((word) => word !== '').length;

/** The findings for the assistant's limits: from a recording's run record (the calls and the tokens of each request), the loop-cost record (the calls, steps, rows and tokens of each turn with the loop on) and the set's messages (their words). */
function findingsOf(runRecord: z.infer<typeof runRecordSchema>, loopRecord: z.infer<typeof loopRecordSchema>, sets: readonly AssistantSet[], hooks: Hooks): readonly Finding[] {
  const limits = hooks.assistantLimits();
  const perCall = (tokens: number, calls: number): number => Math.ceil(tokens / Math.max(1, calls));
  const requests = runRecord.outcomes.filter((outcome) => outcome.calls > 0);
  const turns = loopRecord.rows.map((entry) => entry.on);
  const note = 'the figure of a turn is its largest single call; the figure of a router request is the mean of its calls, since the run record holds the tokens of a request and not of each call';
  return [
    judge('tool steps a turn (reads the answer reports)', observe(turns.map((turn) => turn.steps)), limits.steps),
    judge('model calls a turn', observe([...turns.map((turn) => turn.total), ...requests.map((request) => request.calls)]), limits.calls),
    judge('rows a turn', observe([]), { default: 0, highest: 0 }, 'not measured: the reads of the loop-cost run are a stand-in that returns the same fixed rows; the limit is the source\'s own `max_page` times the steps'),
    judge('input tokens of a call', observe([...turns.map((turn) => turn.maxInputTokens), ...requests.map((request) => perCall(request.inputTokens, request.calls))]), limits.inputTokens, note),
    judge('output tokens of a call', observe([...turns.map((turn) => turn.maxOutputTokens), ...requests.map((request) => perCall(request.outputTokens, request.calls))]), limits.outputTokens, note),
    judge('words of a message', observe(unitsOf(sets).map((unit) => wordsOf(unit.message))), limits.words, 'the maximum of a synthetic set of short messages cannot confirm the limit for real messages: it stays a hypothesis unless it is accepted'),
  ];
}

const shown = (value: number): string => String(value);

export function defaultsLines(findings: readonly Finding[]): string[] {
  return findings.flatMap((finding) => [
    `${finding.setting}: observed ${shown(finding.observed.count)} (max ${shown(finding.observed.max)}, p95 ${shown(finding.observed.p95)}, p99 ${shown(finding.observed.p99)}) against default ${shown(finding.default)}, highest ${shown(finding.highest)}: ${finding.verdict} (against the highest value: ${finding.ceilingVerdict})`,
    ...(finding.proposed === undefined ? [] : [`  proposed: ${shown(finding.proposed)}`]),
    `  ${finding.reason}`,
  ]);
}

export interface DefaultsOptions {
  readonly runRecord: string;
  readonly loopCost: string;
  readonly out?: string;
  readonly force: boolean;
}

/** Reads the records of the runs and prints, for each limit of the assistant, what was observed, the verdict and a proposal; writes a record of the findings to a private folder when one is given. It changes no file of the repository. */
export function runDefaults(sets: readonly AssistantSet[], options: DefaultsOptions, hooks: Hooks): { readonly lines: string[]; readonly code: number } {
  const runRecord = parseRecord(readFileSync(options.runRecord, 'utf8'), runRecordSchema, 'run record');
  const loopRecord = parseRecord(readFileSync(options.loopCost, 'utf8'), loopRecordSchema, 'loop-cost record');
  const findings = findingsOf(runRecord, loopRecord, sets, hooks);
  if (options.out !== undefined) {
    requireOutsideGitTree(options.out, '--out');
    prepareOutFolder(options.out);
    checkPrivateTarget(join(options.out, 'defaults-record.json'), options.force);
    writePrivateFile(join(options.out, 'defaults-record.json'), `${JSON.stringify({ findings }, null, 2)}\n`, options.force);
  }
  return { lines: defaultsLines(findings), code: findings.some((finding) => finding.verdict === 'over') ? 1 : 0 };
}
