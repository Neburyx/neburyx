import { appendFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assistantSetHash, unitsOf, type AssistantSet } from './assistant-questions.js';
import { inputOf, requestsOf, type Hooks } from './assistant-replay.js';
import { checkPrivateTarget, prepareOutFolder, requireOutsideGitTree, writePrivateFile } from './paths.js';
import { UsageError } from './questions.js';
import { parseReplay, replayText, type Replay } from './replay-file.js';

/** The ratio of bytes to tokens the product uses to estimate the size of a text before it is sent. */
const BYTES_PER_TOKEN = 1.8;
/** The most calls one message can cost: the first reply and the single repeat. */
const MOST_CALLS = 2;

export interface AssistantRecordOptions {
  readonly dryRun: boolean;
  readonly budget?: number;
  readonly out?: string;
  readonly force: boolean;
  /** Continues the recording an earlier run left in `--out`: the calls of its log count against the budget, and the requests it answered are not asked again. */
  readonly resume?: boolean;
  /** The folder whose absolute path stands for the settings of Ask during the run. */
  readonly folder: string;
  /** The model of the run when it is not the assistant's setting. */
  readonly model?: string;
}

const RUN_LOG = 'run.log';

/** One line of the run log: the start of the run (the model, the router text hashes and the set hash, never a wording), a call made, a call's end, or the resume of a stopped run. */
type LogLine = { readonly start: { readonly model: string; readonly routerTextHashes: Record<string, string>; readonly setHash: string } } | { readonly call: number; readonly request: string; readonly state: 'sent' | 'ok' | 'failed' } | { readonly resumed: { readonly callsBefore: number } };

function appendLog(path: string, line: LogLine): void {
  appendFileSync(path, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** What a stopped run left: the start it was made under and the calls it made (a call that was sent counts whether or not it came back). */
function readLog(path: string): { readonly start: Extract<LogLine, { start: unknown }>['start']; readonly calls: number } {
  const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line !== '').map((line): unknown => {
    try {
      return JSON.parse(line);
    } catch {
      throw new UsageError('the run log is not readable');
    }
  });
  const first = lines[0] as Partial<Extract<LogLine, { start: unknown }>> | undefined;
  if (first?.start === undefined) throw new UsageError('the run log does not begin with the start of a run');
  const calls = lines.filter((line) => (line as { state?: string }).state === 'sent').length;
  return { start: first.start, calls };
}

async function hashesOf(sets: readonly AssistantSet[], hooks: Hooks): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const set of sets) hashes[set.source.sourceId] = await hooks.routerTextSha256(set.source);
  return hashes;
}

/** An estimate of the input of a whole run: each request's values and the router's instruction text of its source, at the product's bytes to a token. */
async function estimatedTokens(sets: readonly AssistantSet[], hooks: Hooks): Promise<number> {
  const requests = await requestsOf(sets, hooks);
  const sizes = new Map<string, number>();
  for (const set of sets) sizes.set(set.label, await hooks.routerTextBytes(set.source));
  let bytes = 0;
  for (const unit of unitsOf(sets)) bytes += Buffer.byteLength(requests.get(unit.name)?.first ?? '', 'utf8') + (sizes.get(unit.set.label) ?? 0);
  return Math.ceil(bytes / BYTES_PER_TOKEN);
}

/**
 * A recording run of the assistant's router: each message or turn is routed through the router built as the product builds it, within a budget that covers the most each one can cost, counted before it is made. The dry run
 * makes no call and needs no key. Returns the lines to print and the exit code; nothing it prints holds a wording, a reply or a key.
 */
export async function recordAssistant(sets: readonly AssistantSet[], options: AssistantRecordOptions, hooks: Hooks, env: Readonly<Record<string, string | undefined>>): Promise<{ readonly lines: string[]; readonly code: number }> {
  const units = unitsOf(sets);
  const requests = units.length;
  const settings = hooks.assistantRunSettings(env, options.model);
  const hashes = await hashesOf(sets, hooks);
  if (options.dryRun) {
    return {
      code: 0,
      lines: [
        `requests to route: ${requests}`,
        `calls: at least ${requests}, at most ${requests * MOST_CALLS}`,
        `model: ${settings.model}`,
        `effort: ${settings.effort}`,
        `output limit: ${settings.outputLimit}`,
        ...sets.map((set) => `router text hash ${set.label}: ${hashes[set.source.sourceId]}`),
        `set hash: ${assistantSetHash(sets)}`,
        `estimated input tokens: ${await estimatedTokens(sets, hooks)}`,
      ],
    };
  }
  if (options.budget === undefined || !Number.isSafeInteger(options.budget) || options.budget < 1) throw new UsageError('a recording run needs --budget, a whole number of calls');
  if (options.budget < requests * MOST_CALLS) throw new UsageError(`the budget ${options.budget} is below the ${requests * MOST_CALLS} calls the run may need (${MOST_CALLS} for each of ${requests} requests)`);
  if (options.out === undefined) throw new UsageError('a recording run needs --out, a folder outside every git working tree');
  requireOutsideGitTree(options.out, '--out');
  prepareOutFolder(options.out);
  const logPath = join(options.out, RUN_LOG);
  const recordingPath = join(options.out, 'recording.json');
  const resuming = options.resume === true;
  if (resuming && options.force) throw new UsageError('--resume continues a run and --force replaces one: give one of them');
  if (resuming) {
    for (const path of [logPath, recordingPath]) if (!existsSync(path)) throw new UsageError('--resume needs the run.log and the recording.json that a stopped run left in --out');
    checkPrivateTarget(join(options.out, 'run-record.json'), true);
  } else {
    for (const name of [RUN_LOG, 'recording.json', 'run-record.json']) checkPrivateTarget(join(options.out, name), options.force);
  }
  const live = await hooks.liveAssistantProvider(env, options.folder, options.model);
  const before = resuming ? readLog(logPath) : undefined;
  const earlier = resuming ? parseReplay(readFileSync(recordingPath, 'utf8')) : undefined;
  if (before !== undefined && earlier !== undefined) {
    if (before.start.model !== live.model || earlier.model !== live.model) throw new UsageError('the stopped run was made with another model; it cannot be resumed with this one');
    if (JSON.stringify(before.start.routerTextHashes) !== JSON.stringify(hashes) || JSON.stringify(earlier.folders) !== JSON.stringify(hashes)) throw new UsageError('the stopped run was made under another router text; it cannot be resumed');
    if (before.start.setHash !== assistantSetHash(sets)) throw new UsageError('the stopped run was made over another set of questions; it cannot be resumed');
    if (options.budget - before.calls < MOST_CALLS) throw new UsageError(`the log already holds ${before.calls} calls: the budget ${options.budget} cannot cover another request`);
  }
  const callsBefore = before?.calls ?? 0;
  if (before === undefined) {
    if (options.force && existsSync(logPath)) writePrivateFile(logPath, '', true);
    appendLog(logPath, { start: { model: live.model, routerTextHashes: hashes, setHash: assistantSetHash(sets) } });
  } else {
    appendLog(logPath, { resumed: { callsBefore } });
  }
  const recording = hooks.recordingProvider(live.provider, options.budget - callsBefore);
  let current = '';
  let made = callsBefore;
  const asked = Object.create(recording.provider as object) as { complete: (request: unknown, signal?: AbortSignal) => Promise<unknown> };
  asked.complete = async (request, signal) => {
    made += 1;
    const number = made;
    appendLog(logPath, { call: number, request: current, state: 'sent' });
    try {
      const result = await (recording.provider as { complete: (request: unknown, signal?: AbortSignal) => Promise<unknown> }).complete(request, signal);
      appendLog(logPath, { call: number, request: current, state: (result as { status?: string } | undefined)?.status === 'ok' ? 'ok' : 'failed' });
      return result;
    } catch (error) {
      appendLog(logPath, { call: number, request: current, state: 'failed' });
      throw error;
    }
  };
  const outcomes: { readonly name: string; readonly status: string; readonly calls: number; readonly inputTokens: number; readonly outputTokens: number }[] = [];
  const recorded = new Set<string>(Object.keys(earlier?.answers ?? {}));
  const found = await requestsOf(sets, hooks);
  let stopped = false;
  let failedWith: unknown;
  try {
    for (const unit of units) {
      const first = found.get(unit.name)?.first ?? '';
      if (recorded.has(first)) continue;
      // a stop never falls inside the router: the run goes on only when the budget covers the most this request can cost
      if (options.budget - callsBefore - recording.usage().calls < MOST_CALLS) {
        stopped = true;
        break;
      }
      const beforeUsage = recording.usage();
      current = unit.name;
      const outcome = await hooks.routeMessage(unit.set.source, asked, live.model, inputOf(unit));
      const after = recording.usage();
      recorded.add(first);
      outcomes.push({ name: unit.name, status: outcome.status, calls: 'calls' in outcome ? outcome.calls : 0, inputTokens: after.inputTokens - beforeUsage.inputTokens, outputTokens: after.outputTokens - beforeUsage.outputTokens });
      writePrivateFile(recordingPath, replayText({ model: live.model, folders: hashes, answers: { ...earlier?.answers, ...Object.fromEntries(recording.answers()) } }), true);
    }
  } catch (error) {
    failedWith = error;
  }
  const usage = recording.usage();
  const replay: Replay = { model: live.model, folders: hashes, answers: { ...earlier?.answers, ...Object.fromEntries(recording.answers()) } };
  const record = {
    model: live.model,
    effort: live.effort,
    outputLimit: live.outputLimit,
    /** The limits the run measured under: the product's defaults, whatever the settings given to the run. */
    settingsUsed: { maxCalls: hooks.loopDefaults().maxCalls, maxSteps: hooks.loopDefaults().steps, contextTurns: hooks.contextTurns(), maxInputTokens: hooks.assistantLimits().inputTokens.default },
    routerTextHashes: hashes,
    setHash: assistantSetHash(sets),
    requests,
    routed: outcomes.length,
    stoppedAtBudget: stopped,
    stoppedByError: failedWith !== undefined,
    calls: callsBefore + usage.calls,
    callsBeforeResume: callsBefore,
    failedCalls: usage.failed,
    tokens: { input: usage.inputTokens, output: usage.outputTokens, cacheRead: usage.cacheReadTokens, cacheWrite: usage.cacheWriteTokens, callsWithoutCounts: usage.withoutCounts },
    outcomes,
  };
  writePrivateFile(recordingPath, replayText(replay), true);
  writePrivateFile(join(options.out, 'run-record.json'), `${JSON.stringify(record, null, 2)}\n`, options.force || resuming);
  return {
    code: stopped || failedWith !== undefined ? 1 : 0,
    lines: [
      `calls: ${callsBefore + usage.calls} of ${options.budget}`,
      `requests routed: ${outcomes.length} of ${requests}`,
      `model: ${live.model}`,
      `effort: ${live.effort}`,
      ...sets.map((set) => `router text hash ${set.label}: ${hashes[set.source.sourceId]}`),
      `tokens: in ${usage.inputTokens}, out ${usage.outputTokens}, cache read ${usage.cacheReadTokens}, cache write ${usage.cacheWriteTokens}, calls without counts ${usage.withoutCounts}`,
      `failed calls: ${usage.failed}`,
      ...(stopped ? ['stopped at the budget: the recording holds the requests routed so far'] : []),
      ...(failedWith !== undefined ? ['stopped by an unexpected error: the recording holds the requests routed so far'] : []),
    ],
  };
}
