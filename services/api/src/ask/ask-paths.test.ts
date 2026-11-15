import { readClassification, type AskClassification, type AskClassifier } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { SHORTEST_PATHS_COUNT_ID } from '../gate/templates/shortest-paths-count.js';
import { SHORTEST_PATHS_ID } from '../gate/templates/shortest-paths.js';
import { communitySeams } from '../seams/community-seams.js';
import type { AuditEvent } from '../seams/seams.js';
import { makeAskFolder, removeAskFolders } from '../testing/ask-folder.js';
import { configuredWith } from '../testing/demo-packs.js';
import { linkedMappingOf, LINKED_RELATIONSHIPS } from '../testing/linked-entities-fixtures.js';
import { makerNodes, PATHS_ENTITIES } from '../testing/paths-fixtures.js';
import { startSearchApp } from '../testing/search-app.js';

afterAll(removeAskFolders);

const INTENTS = {
  pathsBetween: {
    parameters: ['first', 'second'],
    template: 'shortest-paths',
    settings: { ends: [{ entityType: 'maker', stableId: '$first' }, { entityType: 'maker', stableId: '$second' }], relTypes: ['LINKS'], maxHops: 3, limit: 5 },
  },
};

const QUESTION = 'How are A-1 and Z-1 connected?';

function classifier(entities: Record<string, string>, counter: { calls: number }): AskClassifier {
  return {
    availability: () => ({ available: true }),
    classify: async (): Promise<AskClassification> => {
      counter.calls += 1;
      const read = readClassification(JSON.stringify({ intent: 'pathsBetween', entities }), ['pathsBetween']);
      if (!read.ok) return { ok: false, cause: read.cause };
      return read.intent === null ? { ok: false, cause: 'no-intent' } : { ok: true, intent: read.intent, entities: read.entities };
    },
  };
}

interface Options {
  readonly entities?: Record<string, string>;
  readonly rows?: readonly Record<string, unknown>[];
  readonly probe?: Record<string, unknown>;
  readonly budgets?: Record<string, number>;
  readonly timeout?: 'with-rows' | 'no-rows';
  readonly intents?: unknown;
}

async function started(options: Options = {}) {
  const { rows } = makerNodes();
  const paths = options.rows ?? rows('A-1', 'Z-1', [['A-1', 'M-2', 'Z-1'], ['A-1', 'M-1', 'Z-1']]);
  const respond = (call: ExecuteCall): Promise<ExecuteOutcome> => {
    if (call.templateId === SHORTEST_PATHS_COUNT_ID) return Promise.resolve({ status: 'rows', rows: [options.probe ?? { toFound: true, fromDegree: 1, toDegree: 1 }] });
    if (call.templateId === SHORTEST_PATHS_ID && options.timeout !== undefined) return Promise.resolve(options.timeout === 'with-rows' ? { status: 'timeout', rows: paths } : { status: 'timeout', rows: [] });
    return Promise.resolve({ status: 'rows', rows: paths });
  };
  const mapping = linkedMappingOf({ entities: PATHS_ENTITIES, relationships: LINKED_RELATIONSHIPS, ...(options.budgets === undefined ? {} : { budgets: options.budgets }) });
  const folder = makeAskFolder(['demo'], options.intents ?? INTENTS);
  const { extension, outcome } = await configuredWith(folder, ['demo']);
  expect(outcome).toEqual({ ok: true });
  const asked: AuditEvent[] = [];
  const classified = { calls: 0 };
  const audit = { record: (event: AuditEvent) => Promise.resolve(void asked.push(event)) };
  const seams = { ...communitySeams(), audit, askClassifier: classifier(options.entities ?? { first: 'A-1', second: 'Z-1' }, classified) };
  const rig = await startSearchApp({ mapping, respond, audit, appOptions: { extension, previewOn: true, seams } });
  return { ...rig, events: asked, classified };
}

type Rig = Awaited<ReturnType<typeof started>>;
const json = { 'content-type': 'application/json' };
const ask = (app: Rig['app']) => app.inject({ method: 'POST', url: '/v1/ask', payload: JSON.stringify({ sourceId: 'demo', question: QUESTION }), headers: json });
const route = (app: Rig['app'], extra: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: '/v1/graph/paths', payload: JSON.stringify({ sourceId: 'demo', from: { entityType: 'maker', stableId: 'A-1' }, to: { entityType: 'maker', stableId: 'Z-1' }, relTypes: ['LINKS'], maxHops: 3, limit: 5, ...extra }), headers: json });

const withoutTime = (answer: unknown): unknown => {
  if (typeof answer !== 'object' || answer === null) return answer;
  const { elapsedMs: _elapsed, ...rest } = answer as Record<string, unknown>;
  return rest;
};

describe('a path intent of the Ask folder, from the question to the run', () => {
  it('answers the same paths, nodes and relationships as POST /v1/graph/paths for the same ends, types, hops and cap', async () => {
    const { app } = await started();
    const asked = await ask(app);
    expect(asked.statusCode, asked.body).toBe(200);
    const body = asked.json();
    expect(body.answered).toMatchObject({ intent: 'pathsBetween', entities: { first: 'A-1', second: 'Z-1' }, outcome: 'complete', result: { templateId: 'shortest-paths' } });
    const manual = await route(app);
    expect(manual.statusCode).toBe(200);
    expect(withoutTime(body.answered.result.result)).toEqual(withoutTime(manual.json()));
    expect(body.answered.summary.sentences[0].text).toBe('Found 2 shortest paths of 2 hops between A-1 and Z-1.');
    expect(body.answered.summary.sentences).toHaveLength(3);
    await app.close();
  });

  it('goes through the paths service: the gate reads once for the count and once for the paths, and the events hold the template and a keyed hash, never an entity value', async () => {
    const { app, events, executor } = await started();
    await ask(app);
    const actions = events.map((event) => event.action);
    expect(actions.filter((action) => action === 'graph.shortest_paths_count')).toHaveLength(1);
    expect(actions.filter((action) => action === 'graph.shortest_paths_run')).toHaveLength(1);
    expect(actions.filter((action) => action === 'ask.question')).toHaveLength(1);
    expect(executor.calls.filter((call) => call.templateId === SHORTEST_PATHS_ID)).toHaveLength(1);
    const asked = events.find((event) => event.action === 'ask.question');
    expect(JSON.stringify(asked)).toContain('shortest-paths');
    for (const value of ['A-1', 'Z-1', QUESTION]) expect(JSON.stringify(asked), value).not.toContain(value);
    await app.close();
  });

  it('answers nothing-found for an end that is not in the source, and lists no path', async () => {
    const { app } = await started({ probe: { toFound: false, fromDegree: 1, toDegree: 0 } });
    const body = (await ask(app)).json();
    expect(body).toMatchObject({ refused: { cause: 'nothing-found' } });
    await app.close();
  });

  it('refuses a source whose limits are lower than the intent asks, with the gate’s figure, and reads no path', async () => {
    const { app, executor } = await started({ budgets: { max_hops: 2 } });
    const asked = await ask(app);
    expect(asked.statusCode).toBe(422);
    expect(asked.json()).toMatchObject({ error: { code: 'QUERY_BUDGET_EXCEEDED', details: { maxHops: 2 } } });
    expect(executor.calls.filter((call) => call.templateId === SHORTEST_PATHS_ID || call.templateId === SHORTEST_PATHS_COUNT_ID)).toEqual([]);
    await app.close();
  });

  it('refuses a cap above the source’s path result cap with its figure', async () => {
    const intents = { pathsBetween: { ...INTENTS.pathsBetween, settings: { ...INTENTS.pathsBetween.settings, limit: 20 } } };
    const { app } = await started({ intents, budgets: { path_results_cap: 10 } });
    const asked = await ask(app);
    expect(asked.statusCode).toBe(422);
    expect(asked.json()).toMatchObject({ error: { code: 'QUERY_BUDGET_EXCEEDED', details: { pathResultsCap: 10 } } });
    await app.close();
  });

  it('refuses the two ends being one entity as invalid values, and reads nothing', async () => {
    const { app, executor } = await started({ entities: { first: 'A-1', second: 'A-1' } });
    const asked = await ask(app);
    expect(asked.json()).toMatchObject({ error: { code: 'ASK_INTENT_INVALID' } });
    expect(executor.calls.filter((call) => call.templateId === SHORTEST_PATHS_ID)).toEqual([]);
    await app.close();
  });
});

describe('a path intent that is heavy, cut or empty, with the real gate', () => {
  const probes = (executor: Rig['executor']) => executor.calls.filter((call) => call.templateId === SHORTEST_PATHS_COUNT_ID);
  const reads = (executor: Rig['executor']) => executor.calls.filter((call) => call.templateId === SHORTEST_PATHS_ID);
  const heavyProbe = { toFound: true, fromDegree: 300, toDegree: 300 };
  const stopped = async (rig: Rig) => (await ask(rig.app)).json().answered as { outcome: string; continueToken: string; summary?: unknown; result: { result: { status: string; continueLimit: number } } };
  const more = (rig: Rig, token: string, over: Record<string, unknown> = {}) =>
    rig.app.inject({ method: 'POST', url: '/v1/ask/continue', payload: JSON.stringify({ sourceId: 'demo', intent: 'pathsBetween', entities: { first: 'A-1', second: 'Z-1' }, continueToken: token, ...over }), headers: json });

  it('stops as heavy at the threshold with a token and no summary, and runs no search', async () => {
    const rig = await started({ probe: heavyProbe });
    const answer = await stopped(rig);
    expect(answer).toMatchObject({ outcome: 'partial', result: { templateId: 'shortest-paths', result: { status: 'heavy', continueLimit: 5 } } });
    expect(answer.summary).toBeUndefined();
    expect(reads(rig.executor)).toHaveLength(0);
    await rig.app.close();
  });

  it('continues at the least of 25, the intent’s cap and the source’s, with no probe, no estimate and no model call', async () => {
    const { rows } = makerNodes();
    const rig = await started({ probe: heavyProbe, rows: rows('A-1', 'Z-1', [['A-1', 'Z-1']]) });
    const answer = await stopped(rig);
    const calls = rig.classified.calls;
    const continued = await more(rig, answer.continueToken);
    expect(continued.statusCode, continued.body).toBe(200);
    const body = continued.json().answered;
    expect(body).toMatchObject({ outcome: 'complete', result: { templateId: 'shortest-paths', result: { status: 'ok' } } });
    expect('estimate' in body.result.result).toBe(false);
    expect(probes(rig.executor)).toHaveLength(1);
    expect(reads(rig.executor)[0]?.parameters).toMatchObject({ limit: 5 });
    expect(rig.classified.calls).toBe(calls);
    expect(rig.events.map((event) => event.action).filter((action) => action.startsWith('ask.'))).toEqual(['ask.question', 'ask.continue']);
    await rig.app.close();
  });

  it('refuses a token used with other entities, and reads nothing', async () => {
    const rig = await started({ probe: heavyProbe });
    const answer = await stopped(rig);
    const before = rig.executor.calls.length;
    const refused = await more(rig, answer.continueToken, { entities: { first: 'A-1', second: 'Z-9' } });
    expect(refused.json()).toMatchObject({ error: { code: 'INVALID_REQUEST', details: { reason: 'continue-invalid' } } });
    expect(rig.executor.calls.length).toBe(before);
    await rig.app.close();
  });

  it('answers a search that timed out with paths as partial, and one with no path as QUERY_TIMEOUT with its limit', async () => {
    const kept = await started({ timeout: 'with-rows' });
    expect((await ask(kept.app)).json().answered).toMatchObject({ outcome: 'partial', result: { result: { partial: true, retained: 2, requested: 5 } } });
    await kept.app.close();
    const none = await started({ timeout: 'no-rows' });
    const answer = await ask(none.app);
    expect(answer.statusCode).toBe(504);
    expect(answer.json()).toMatchObject({ error: { code: 'QUERY_TIMEOUT', details: { timeoutMs: 5000 } } });
    await none.app.close();
  });

  it('answers nothing-found for two entities that exist with no path between them', async () => {
    const { rows } = makerNodes();
    const rig = await started({ rows: rows('A-1', 'Z-1', []) });
    expect((await ask(rig.app)).json()).toMatchObject({ refused: { cause: 'nothing-found', intent: 'pathsBetween' } });
    await rig.app.close();
  });
});
