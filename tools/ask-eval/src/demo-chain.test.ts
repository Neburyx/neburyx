import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { askSummarySchema, type AskSummary, type ExtensionRequest, type ElementRef } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { citedKeysExist, listedElements } from '../../../ee/ask/src/summary/index.js';
import { replayProvider } from '../../../ee/ask/src/eval/replay-planner.js';
import { plannerOver } from '../../../ee/ask/src/eval/replay-planner.js';
import { catalogWords } from '../../../ee/ask/src/planner/catalog.js';
import { REFUSAL_SENTENCES } from '../../../ee/ask/src/refusal/families.js';
import { createAskPlanRoute } from '../../../ee/ask/src/routes/ask-plan.js';
import { createAskRunRoute } from '../../../ee/ask/src/routes/ask-run.js';
import { createMemoryPlanStore } from '../../../ee/ask/src/testing/memory-plans.js';
import { questionVocabulary } from '../../../ee/ask/src/vocabulary/vocabulary.js';
import type { PlaceholderEntry } from '../../../ee/ask/src/resolution/index.js';
import { createAskPlanRunnerFactory } from '../../../services/api/dist/ask/plan-runner.js';
import { loadMappingFile } from '../../../services/api/dist/mapping/load.js';
import { loadMapping } from './mapping-view.js';
import { loadQuestions, type Question } from './questions.js';
import { parseReplay } from './replay.js';
import { scriptedResult } from './testing/scripted-results.js';
import type { Replay } from './types.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const PACKS = join(ROOT, 'domain-packs');
const QUESTIONS = loadQuestions(join(ROOT, 'services', 'api', 'tests', 'ask', 'questions.yaml'));
const REPLAY: Replay = parseReplay(readFileSync(join(ROOT, 'services', 'api', 'tests', 'ask', 'replies.json'), 'utf8'));
const PLACEHOLDER = /‹([A-Za-z0-9_-]+)#([1-9][0-9]*)›/g;
const mac = (canonical: string): string => createHmac('sha256', 'chain-test').update(canonical).digest('hex');

/** A resolution of a question that is already in planner form: each placeholder stands for one entity of the demo source (a value placeholder for a quoted reference). */
function resolution(message: string, SOURCE: string) {
  const spans = [...message.matchAll(PLACEHOLDER)].map((match) => ({ start: match.index, end: match.index + match[0].length, placeholder: match[0], typedStart: match.index, typedEnd: match.index + match[0].length }));
  const placeholders = new Map<string, PlaceholderEntry>(
    [...message.matchAll(PLACEHOLDER)].map((match) => [match[0], match[1] === 'value' ? { kind: 'value' as const, text: 'REF-1' } : { kind: 'entity' as const, ref: { sourceId: SOURCE, entityType: match[1] ?? '', stableId: `${match[1]}-${match[2]}` } as ElementRef }]),
  );
  return { status: 'resolved' as const, text: message, spans, placeholders, capReached: false };
}

type Outcome = { readonly kind: 'refusal'; readonly family: string; readonly reason: string; readonly stored: number; readonly runs: number } | { readonly kind: 'run'; readonly result: Parameters<typeof listedElements>[0] | undefined; readonly summary: AskSummary | undefined; readonly summaryOk: boolean; readonly stored: number; readonly runs: number };

/** One question through the plan route, over the replay, and, when a plan comes back, through the run route over a scripted source. */
async function chainOf(question: Question, replay: Replay): Promise<Outcome> {
  const packPath = join(PACKS, question.pack ?? '', 'neburyx.yaml');
  const { view } = loadMapping(packPath);
  const { planner } = await plannerOver(view, (built) => replayProvider(replay, built.registry), 'replay');
  const plans = createMemoryPlanStore();
  let runs = 0;
  const model = loadMappingFile(packPath);
  const source = model.sources[0];
  if (source === undefined) throw new Error(`the pack of the question ${question.id} has no source`);
  const SOURCE = source.id;
  const refOf = (ref: { entityType: string; stableId: string }) => ({ ref: { entityType: ref.entityType, stableId: ref.stableId } });
  /** The services of the manual routes, each answering a fixed, contract-valid result: the runner, its checks of the stored parameters and its dispatch are the product's own. */
  const answer = (templateId: string, params: Record<string, unknown>) => {
    runs += 1;
    return scriptedResult(templateId, params, SOURCE).result as never;
  };
  const factory = createAskPlanRunnerFactory({
    templateRuns: { run: async (call: { id: string; params: unknown }) => answer(call.id, call.params as Record<string, unknown>) },
    entities: { read: async (call: { entityType: string; stableId: string }) => answer('entity', refOf(call)) },
    degrees: { preview: async (call: { entityType: string; stableId: string }) => answer('degree-preview', refOf(call)) },
    expansions: { expand: async (call: { entityType: string; stableId: string; relTypes?: string[]; neighborTypes: string[] }) => answer('expand', { ...refOf(call), relTypes: call.relTypes, neighborTypes: call.neighborTypes }) },
    derivedNeighbors: {
      derive: async (call: { entityType: string; stableId: string }) => {
        runs += 1;
        const results = source.derived.flatMap((rule) => (scriptedResult('derived-rule-run', { ...refOf(call), ruleId: rule.id }, SOURCE).result as { results: unknown[] }).results);
        return { ref: { sourceId: SOURCE, entityType: call.entityType, stableId: call.stableId }, results } as never;
      },
    },
    edges: {
      read: async (call: { ref: { derived?: { ruleId: string; from: unknown; to: unknown } } }) => {
        const derived = call.ref.derived;
        if (derived === undefined) throw new Error('a run reads a derived relationship');
        return answer('derived-edge-support', { ruleId: derived.ruleId, ends: [derived.from, derived.to] });
      },
    },
    searching: { search: async (call: { entityTypes: string[] }) => answer('search', { entityTypes: call.entityTypes }) },
    savedRuns: { find: async () => Promise.reject(new Error('not used')), run: async () => Promise.reject(new Error('not used')) },
    mapping: model,
  } as never);
  const runner = (scope: { sourceId: string; mask: boolean }) => factory({ principal: { id: 'p', displayName: 'p', role: 'investigator' } as never, traceId: 'tr-chain' })(scope as never);
  const request = (body: unknown): ExtensionRequest =>
    ({
      principalId: 'p',
      principalRole: 'investigator',
      previewOn: true,
      traceId: 'tr-chain',
      audit: { record: async () => undefined },
      askPlanner: planner,
      askPlanRunner: runner,
      previewMac: mac,
      policyVersionOf: () => 'none',
      askEntityTools: () => ({ search: async () => ({ refs: [], unreferenced: 0, count: { quality: 'unknown', scope: 'exact matches' } }), lookup: async () => true, ensureSource: async () => undefined }),
      body,
    }) as unknown as ExtensionRequest;
  const planRoute = createAskPlanRoute({ resolve: async ({ message }) => resolution(message, SOURCE), plans: () => plans, vocabulary: () => questionVocabulary({ view, catalogWords: catalogWords() }) });
  const shown = (await planRoute.handler(request({ message: question.wording, sourceId: SOURCE }))) as { previewHash?: string };
  if (shown.previewHash === undefined) throw new Error(`the question ${question.id} did not reach a preview`);
  const answered = (await planRoute.handler(request({ message: question.wording, sourceId: SOURCE, send: true, previewHash: shown.previewHash }))) as { plan?: { kind: string; family?: string; reason?: string }; planId?: string };
  if (answered.plan?.kind === 'unsupported') return { kind: 'refusal', family: answered.plan.family ?? '', reason: answered.plan.reason ?? '', stored: plans.plans.length, runs };
  if (answered.planId === undefined) throw new Error(`the question ${question.id} was not answered with a plan or a refusal`);
  const run = createAskRunRoute({ plans: () => plans });
  const ran = (await run.handler(request({ planId: answered.planId }))) as { result: Parameters<typeof listedElements>[0]; summary?: AskSummary };
  const listed = listedElements(ran.result);
  const summaryOk = ran.summary !== undefined && listed !== undefined && askSummarySchema.safeParse(ran.summary).success && citedKeysExist(ran.summary, listed) && ran.summary.citations.every((citation) => citation.element.sourceId === SOURCE);
  return { kind: 'run', result: ran.result, summary: ran.summary, summaryOk, stored: plans.plans.length, runs };
}

/** One question through the chain; a failure of any step names the question. */
async function chain(question: Question, replay: Replay): Promise<Outcome> {
  try {
    return await chainOf(question, replay);
  } catch (error) {
    throw new Error(`the question ${question.id} failed: ${error instanceof Error ? error.message : 'unknown'}`);
  }
}

/** What a question's summary must be: every statement cites at least one key, and every key is of an element the result lists; a failure names the question. */
function assertCited(id: string, summary: AskSummary | undefined, ok: boolean): void {
  if (summary === undefined) throw new Error(`the question ${id} has no summary`);
  if (!ok || summary.sentences.some((sentence) => sentence.cites.length === 0)) throw new Error(`the question ${id} has a statement that is not cited`);
}

const planQuestions = QUESTIONS.filter((question) => question.expect.kind === 'plan');
const refusalQuestions = QUESTIONS.filter((question) => question.expect.kind === 'unsupported');

describe('every demo question, from the question to the cited summary, over the committed replay and scripted services', { timeout: 20_000 }, () => {
  it('has the 25 plan questions and the 8 refusals of the demo set', () => {
    expect([planQuestions.length, refusalQuestions.length]).toEqual([25, 8]);
  });

  it.each(planQuestions.map((question) => [question.id, question] as const))('%s: a plan is stored and run once, and its summary cites only elements the result lists', async (_id, question) => {
    const outcome = await chain(question, REPLAY);
    expect(outcome.kind).toBe('run');
    if (outcome.kind !== 'run') return;
    expect(outcome.stored).toBe(1);
    expect(outcome.runs).toBe(1);
    assertCited(question.id, outcome.summary, outcome.summaryOk);
  });

  it.each(refusalQuestions.map((question) => [question.id, question] as const))('%s: a refusal with a family and its fixed sentence, no plan stored, no run', async (_id, question) => {
    const outcome = await chain(question, REPLAY);
    expect(outcome.kind).toBe('refusal');
    if (outcome.kind !== 'refusal') return;
    expect(outcome.reason).toBe(REFUSAL_SENTENCES[outcome.family as keyof typeof REFUSAL_SENTENCES]);
    expect(question.expect.kind === 'unsupported' && question.expect.family === outcome.family).toBe(true);
    expect(outcome.stored).toBe(0);
    expect(outcome.runs).toBe(0);
  });

  it('fails and names the question when its rebuilt text has no entry in the replay', async () => {
    const [first] = planQuestions;
    if (first === undefined) throw new Error('no plan question');
    await expect(chain(first, {})).rejects.toThrow(first.id);
  });

  it('fails and names the question when a statement of a summary is not cited, or cites a key nobody holds', async () => {
    const [first] = planQuestions;
    if (first === undefined) throw new Error('no plan question');
    const outcome = await chain(first, REPLAY);
    if (outcome.kind !== 'run' || outcome.summary === undefined || outcome.result === undefined) throw new Error('no summary');
    const listed = listedElements(outcome.result);
    if (listed === undefined) throw new Error('nothing listed');
    const real: AskSummary = outcome.summary;
    const check = (summary: AskSummary) => assertCited(first.id, summary, citedKeysExist(summary, listed));
    expect(() => check(real)).not.toThrow();
    expect(() => check({ ...real, sentences: [...real.sentences, { text: 'A statement with no source.', cites: [] }] })).toThrow(new RegExp(first.id));
    expect(() => check({ ...real, sentences: [{ text: 'A statement that cites a key nobody holds.', cites: ['zz'] }] })).toThrow(new RegExp(first.id));
  });

  it('runs on the replay provider and stubbed entity tools alone: no network, no model key and no Neo4j', () => {
    expect(process.env['NBX_EE_URI']).toBeUndefined();
  });
});
