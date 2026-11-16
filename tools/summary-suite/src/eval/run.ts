import { join } from 'node:path';
import { keyMapOf, loadCases, readingOf, type LabelledCase } from '../cases.js';
import { sentencesOf } from '../checks.js';
import { scoreLabelled, scoreSummary } from '../score.js';
import { causeOf, removedOf } from './diagnose.js';
import type { BudgetUsage, EvalHooks, EvalSummarizer, ReplyObservation, RunSettings } from './hooks.js';
import { manifestOf, richSampleSizes, selectViews, sampleSizes, type MeasureMode } from './manifest.js';
import { elementsOf, estimatedTokensOf, heavyReading, proposalOf, realisticReading, scaledReading, utf8Bytes, type Measurement } from './measure.js';
import { checkPrivateTarget, prepareOutFolder, requireOutsideGitTree, UsageError, writePrivateFile } from './paths.js';
import { jsonOf, recordOf, textOf, type Report, type ViewReport } from './report.js';

export interface RunOptions {
  readonly stub: boolean;
  readonly measure: MeasureMode;
  readonly dryRun: boolean;
  readonly budget?: number;
  readonly views: string;
  readonly json: boolean;
  readonly out?: string;
  readonly force: boolean;
  /** The Ask folder that gives the live provider its settings. */
  readonly folder?: string;
}

type Env = Readonly<Record<string, string | undefined>>;

const EMPTY_REPLY = JSON.stringify({ sentences: [] });
const RECORD_FILE = 'run-record.json';

/** The reply the scripted provider gives for a view: its own labelled `keep` sentences, with the keys the text sent gave its elements. */
function scriptedReply(labelled: LabelledCase, values: string): string {
  const keys = keyMapOf(labelled, values);
  const sentences = labelled.sentences
    .filter((sentence) => sentence.label === 'keep')
    .map((sentence) => ({ text: sentence.text, cites: sentence.cites.flatMap((key) => keys.get(key) ?? []) }));
  return JSON.stringify({ sentences });
}

/** The labelled view the samples of a measuring run are built from: an AML view with relationships, the same for every run. */
function sampleBase(): LabelledCase {
  const found = loadCases().cases.find((each) => each.id === 'aml-fan-in');
  if (found === undefined) throw new Error('the labelled set has no aml-fan-in view');
  return found;
}

const kindOf = (labelled: LabelledCase): 'demo' | 'aml' => (labelled.source_case === undefined ? 'aml' : 'demo');

function notRun(id: string, kind: 'demo' | 'aml'): ViewReport {
  return { id, kind, status: 'not run', calls: 0, factsFound: [], factsMissed: [], claimsMade: [], sentencesWritten: 0, sentencesKept: 0, sentencesRemoved: 0, checked: false, keysStripped: 0, keysRemoved: 0, namesKept: [], verdictInTitle: 0, forReview: [], wronglyRemoved: [], slipped: [], tokens: { known: true, input: 0, output: 0 }, milliseconds: 0 };
}

/** What a run holds while it goes: the view it is on, the text of the first request of the click, what the checks said of each reply, and the budgeted provider that counts. */
interface Run {
  current: LabelledCase | undefined;
  sent: string;
  readonly observations: ReplyObservation[];
  readonly usage: () => BudgetUsage;
  readonly signal: AbortSignal;
  /** Whether the budget is spent or the run was stopped: nothing more is run. */
  stopped: boolean;
  readonly budget: number;
}

async function scoreView(run: Run, summarizer: EvalSummarizer, labelled: LabelledCase): Promise<ViewReport> {
  const kind = kindOf(labelled);
  if (run.signal.aborted || run.stopped || run.usage().calls >= run.budget) {
    run.stopped = true;
    return notRun(labelled.id, kind);
  }
  run.current = labelled;
  run.sent = '';
  run.observations.length = 0;
  const before = run.usage();
  const started = Date.now();
  const done = await summarizer.summarize(readingOf(labelled), run.signal).catch((error: unknown) => {
    if (run.signal.aborted) return undefined;
    throw error;
  });
  const milliseconds = Date.now() - started;
  const after = run.usage();
  const outcome = done?.outcome;
  const kept = outcome === undefined ? [] : sentencesOf(outcome);
  const keys = keyMapOf(labelled, run.sent);
  const score = scoreSummary(labelled, kept, keys);
  const last = run.observations[run.observations.length - 1];
  const causes = last === undefined ? [] : removedOf(last.written, last.kept).map((sentence) => causeOf(sentence, labelled, keys));
  const labelledScore = last === undefined ? { wronglyRemoved: [], slipped: [] } : scoreLabelled(labelled, last.written, last.kept, keys);
  const budgetRefused = after.refused > before.refused;
  if (budgetRefused) run.stopped = true;
  return {
    id: labelled.id,
    kind,
    status: outcome === undefined ? 'cancelled' : outcome.status,
    ...(outcome?.status === 'failed' ? { failureKind: budgetRefused ? 'budget' : outcome.kind } : {}),
    calls: done?.calls ?? after.calls - before.calls,
    factsFound: score.factsFound,
    factsMissed: score.factsMissed,
    claimsMade: score.claimsMade,
    sentencesWritten: last?.written.length ?? 0,
    sentencesKept: last?.kept.length ?? 0,
    sentencesRemoved: last?.removed ?? 0,
    checked: last !== undefined,
    keysStripped: run.observations.reduce((total, each) => total + each.keysStripped, 0),
    keysRemoved: run.observations.reduce((total, each) => total + each.keysRemoved, 0),
    namesKept: score.inventedNamesKept,
    verdictInTitle: causes.filter((each) => each.cause === 'verdictInTitle').length,
    forReview: causes.flatMap((each) => (each.cause === 'forReview' && each.factId !== undefined ? [each.factId] : [])),
    wronglyRemoved: labelledScore.wronglyRemoved,
    slipped: labelledScore.slipped,
    tokens: { known: after.withoutCounts === before.withoutCounts, input: after.inputTokens - before.inputTokens, output: after.outputTokens - before.outputTokens },
    milliseconds,
  };
}

/** One measuring request for a reading, through the product's own assembly and guard. It is measured when the request was made and the provider stated its input tokens, whatever the reply was (a reply cut off at the output limit included): what the summary made of the reply is not looked at. */
async function measureOne(run: Run, summarizer: EvalSummarizer, target: { readonly id: string; readonly kind: 'view' | 'sample'; readonly properties?: 'none' | 'realistic' | 'heavy'; readonly reading: ReturnType<typeof readingOf>; readonly labelled?: LabelledCase }, stub: boolean): Promise<Measurement> {
  const elements = elementsOf(target.reading);
  if (run.signal.aborted || run.stopped || run.usage().calls >= run.budget) {
    run.stopped = true;
    return { id: target.id, kind: target.kind, ...(target.properties === undefined ? {} : { properties: target.properties }), elements, measured: false, missing: 'not run: the budget was spent or the run was stopped' };
  }
  run.current = target.labelled;
  run.sent = '';
  const before = run.usage();
  const done = await summarizer.summarize(target.reading, run.signal).catch((error: unknown) => {
    if (run.signal.aborted) return undefined;
    throw error;
  });
  const after = run.usage();
  const bytes = run.sent === '' ? undefined : utf8Bytes(summarizer.instructions, run.sent);
  const base = { id: target.id, kind: target.kind, ...(target.properties === undefined ? {} : { properties: target.properties }), elements, ...(bytes === undefined ? {} : { bytes, estimatedTokens: estimatedTokensOf(bytes) }) };
  const inputTokens = after.inputTokens - before.inputTokens + (after.cacheReadTokens - before.cacheReadTokens) + (after.cacheWriteTokens - before.cacheWriteTokens);
  if (after.refused > before.refused) {
    run.stopped = true;
    return { ...base, measured: false, missing: 'not run: the budget was spent' };
  }
  if (run.sent === '') return { ...base, measured: false, missing: done?.outcome.status === 'tooLarge' ? 'refused by the size guard: no request was made' : 'no request was made' };
  // the input is what is measured: a call whose reply was cut off (or refused) still had its input counted by the provider; a call that failed without a count did not reach the model
  if (after.withoutCounts > before.withoutCounts || inputTokens <= 0) return { ...base, measured: false, missing: after.failed > before.failed ? 'the call failed' : stub ? 'a scripted provider states no token counts' : 'the provider stated no token counts' };
  return { ...base, measured: true, bytes: bytes ?? 0, inputTokens, bytesPerToken: (bytes ?? 0) / inputTokens, tokensPerElement: inputTokens / elements };
}

function guardLive(options: RunOptions): void {
  if (options.out === undefined) throw new UsageError('a live run needs --out, a folder outside every git working tree');
  if (options.folder === undefined) throw new UsageError('a live run needs --folder, an Ask folder that gives the provider its settings');
  requireOutsideGitTree(options.out, '--out');
  prepareOutFolder(options.out);
  checkPrivateTarget(join(options.out, RECORD_FILE), options.force);
}

/**
 * Summarizes the labelled views through the real summarizer, scores each, and reports. A stub run answers every view with its own labelled sentences and uses no key and no network. The dry run makes no call.
 * Returns the lines to print and the exit code: 0 for a run that finished within its budget, 1 for one that did not (a view not run, or a view that ended in a failure), 2 is the caller's for a usage error.
 */
export async function runEvaluation<Provider>(options: RunOptions, hooks: EvalHooks<Provider>, env: Env, signal: AbortSignal = new AbortController().signal): Promise<{ readonly lines: string[]; readonly code: number; readonly report?: Report }> {
  const settingsRead = hooks.settings(env);
  if (!settingsRead.ok) throw new UsageError(settingsRead.problems.join('; '));
  const { settings } = settingsRead;
  const views = selectViews(loadCases().cases, options.views);
  const manifest = manifestOf(views, settings, options.measure);
  const mode = options.stub ? 'stub' : 'live';
  if (options.dryRun) {
    return {
      code: 0,
      lines: [
        `mode: ${mode}`,
        `model: ${settings.model}`,
        `call limit of a click: ${settings.maxCalls}`,
        ...manifest.categories.map((each) => `${each.name}: ${each.views} views, at most ${each.mostCalls} calls, at least ${each.leastCalls}`),
        `calls: at most ${manifest.mostCalls}, budget needed at least ${manifest.leastCalls}`,
        `size guard: ${settings.maxInputTokens} tokens`,
      ],
    };
  }
  const budget = options.budget ?? (options.stub ? manifest.mostCalls : undefined);
  if (budget === undefined || !Number.isSafeInteger(budget) || budget < 1) throw new UsageError('a live run needs --budget, a whole number of calls');
  if (budget < manifest.leastCalls) throw new UsageError(`the budget ${budget} is below the ${manifest.leastCalls} calls the run needs`);
  if (!options.stub) guardLive(options);
  let current: () => LabelledCase | undefined = () => undefined;
  const inner = options.stub ? hooks.scriptedProvider((values) => scriptedReplyFor(current(), values)) : await liveProviderOf(hooks, options, env, settings);
  const state: Run = { current: undefined, sent: '', observations: [], usage: () => budgeted.usage(), signal, stopped: false, budget };
  current = () => state.current;
  const budgeted = hooks.budgeted(inner, budget, (values) => {
    if (state.sent === '') state.sent = values;
  });
  const built = await hooks.summarizer({ provider: budgeted.provider, settings, env, observe: (observation) => void state.observations.push(observation) });
  if (!built.ok) throw new UsageError(built.problems.join('; '));
  const reports: ViewReport[] = [];
  if (options.measure !== 'only') for (const labelled of views) reports.push(await scoreView(state, built.summarizer, labelled));
  const measurements: Measurement[] = [];
  if (options.measure !== 'none') {
    const measuring = await hooks.summarizer({ provider: budgeted.provider, settings: { ...settings, maxCalls: 1 }, env, observe: () => undefined });
    if (!measuring.ok) throw new UsageError(measuring.problems.join('; '));
    const targets = [
      ...views.map((labelled) => ({ id: labelled.id, kind: 'view' as const, reading: readingOf(labelled), labelled })),
      ...sampleSizes(settings).map((size) => ({ id: `sample-${size}`, kind: 'sample' as const, properties: 'none' as const, reading: scaledReading(sampleBase(), size) })),
      ...richSampleSizes(settings).map((size) => ({ id: `sample-${size}-realistic`, kind: 'sample' as const, properties: 'realistic' as const, reading: realisticReading(scaledReading(sampleBase(), size)) })),
      ...richSampleSizes(settings).map((size) => ({ id: `sample-${size}-heavy`, kind: 'sample' as const, properties: 'heavy' as const, reading: heavyReading(scaledReading(sampleBase(), size)) })),
    ];
    for (const target of targets) measurements.push(await measureOne(state, measuring.summarizer, target, options.stub));
  }
  const proposal = options.measure === 'none' ? undefined : proposalOf(measurements, new Set(views.filter((each) => each.shape !== undefined).map((each) => each.id)), settings.maxElements);
  const usage = budgeted.usage();
  const spent = state.stopped || usage.refused > 0;
  const report: Report = { mode, model: settings.model, instructionsSha256: built.summarizer.instructionsSha256, budget, usage, budgetSpent: spent, views: reports, ...(options.measure === 'none' ? {} : { measurements, ...(proposal === undefined ? {} : { proposal }) }) };
  if (!options.stub && options.out !== undefined) writePrivateFile(join(options.out, RECORD_FILE), `${recordOf(report)}\n`, options.force);
  const failed = reports.some((view) => view.status === 'failed' || view.status === 'timeLimit' || view.status === 'cancelled');
  return { code: spent || failed ? 1 : 0, lines: options.json ? [jsonOf(report)] : textOf(report), report };
}

const scriptedReplyFor = (labelled: LabelledCase | undefined, values: string): string => (labelled === undefined ? EMPTY_REPLY : scriptedReply(labelled, values));

/** The live provider of the hooks, with its refusals (a key in the environment, a key file that cannot be used, settings that cannot be used) turned into a usage error: the message, exit code 2, no stack. */
async function liveProviderOf<Provider>(hooks: EvalHooks<Provider>, options: RunOptions, env: Env, settings: RunSettings): Promise<Provider> {
  try {
    return (await hooks.liveProvider(options.measure === 'none' ? env : { ...env, NEBURYX_AI_CACHE: 'off' }, options.folder ?? '', settings)).provider;
  } catch (error) {
    if (error instanceof Error && error.name === 'LiveProviderError') throw new UsageError(error.message);
    throw error;
  }
}
