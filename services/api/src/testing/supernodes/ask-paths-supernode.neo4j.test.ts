/*
 * A path question that names the supernode anchors of the benchmark (1,000, 10,000 and 100,000 relationships of each of four types, built once by `startRig`), asked through the real Ask route, runner and gate: the
 * question stops as `partial` with a continue token from the probe alone, and the continue returns at most 25 paths with no model call. The classifier is a stand-in that names the intent; nothing here calls a model.
 */
import { readClassification, type AskClassification, type AskClassifier } from '@neburyx/contracts';
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { createLogger } from '../../logger.js';
import { communitySeams } from '../../seams/community-seams.js';
import { memoryAppStore } from '../app-store.js';
import { makeAskFolder, removeAskFolders } from '../ask-folder.js';
import { ENTITIES, hubOf, RELATIONSHIPS } from '../benchmark/fixture.js';
import { SIZES } from '../benchmark/plan.js';
import { startRig, stopRig, type Rig } from '../benchmark/rig.js';
import { configuredWith } from '../demo-packs.js';
import { NEO4J_SERIES, sourceFor } from '../neo4j-server.js';
import { makeWebRoot } from '../web-root.js';

const webRoot = makeWebRoot();
let rig: Rig;
let app: Awaited<ReturnType<typeof buildApp>>;
const classified = { calls: 0 };
let entities: Record<string, string> = {};

const INTENTS = {
  tiedTo: {
    parameters: ['first', 'second'],
    template: 'shortest-paths',
    settings: { ends: [{ entityType: 'hub', stableId: '$first' }, { entityType: 'leaf', stableId: '$second' }], relTypes: ['TIED'], maxHops: 2, limit: 25 },
  },
};

const classifier: AskClassifier = {
  availability: () => ({ available: true }),
  classify: async (): Promise<AskClassification> => {
    classified.calls += 1;
    const read = readClassification(JSON.stringify({ intent: 'tiedTo', entities }), ['tiedTo']);
    if (!read.ok) return { ok: false, cause: read.cause };
    return read.intent === null ? { ok: false, cause: 'no-intent' } : { ok: true, intent: read.intent, entities: read.entities };
  },
};

beforeAll(async () => {
  rig = await startRig();
  const mapping = { sources: [sourceFor(rig.server, { entities: ENTITIES, relationships: RELATIONSHIPS })] };
  const { extension, outcome } = await configuredWith(makeAskFolder(['graph'], INTENTS), ['graph']);
  expect(outcome).toEqual({ ok: true });
  app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping, gate: rig.parts.gate, extension, previewOn: true, seams: { ...communitySeams(), askClassifier: classifier } });
}, 3_600_000);

afterAll(async () => {
  await app?.close();
  rmSync(webRoot, { recursive: true, force: true });
  removeAskFolders();
  await stopRig(rig);
});

const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: JSON.stringify(payload), headers: { 'content-type': 'application/json' } });

describe(`a path question on a supernode on ${NEO4J_SERIES}`, () => {
  it.each(SIZES)('stops as partial from the probe alone for the supernode of %i relationships, and its continue returns at most 25 paths with no model call', async (size) => {
    entities = { first: hubOf(size), second: `${hubOf(size)}-1` };
    const stopped = await post('/v1/ask', { sourceId: 'graph', question: 'How are they connected?' });
    expect(stopped.statusCode, stopped.body).toBe(200);
    const answer = stopped.json().answered;
    expect(answer).toMatchObject({ outcome: 'partial', result: { templateId: 'shortest-paths', result: { status: 'heavy' } } });
    expect(answer.summary).toBeUndefined();
    const calls = classified.calls;
    const continued = await post('/v1/ask/continue', { sourceId: 'graph', intent: 'tiedTo', entities, continueToken: answer.continueToken });
    expect([200, 504]).toContain(continued.statusCode);
    if (continued.statusCode === 200) expect(continued.json().answered.result.result.paths.length).toBeLessThanOrEqual(25);
    expect(classified.calls).toBe(calls);
  }, 600_000);
});
