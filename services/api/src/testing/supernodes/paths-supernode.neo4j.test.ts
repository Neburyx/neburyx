/*
 * The shortest-paths run on the supernode anchors of the benchmark (1,000, 10,000 and 100,000 relationships of each of four types, built once by `startRig`): the probe, the heavy-operation stop, the continue at 25
 * and a search that has to expand the supernode (two of its neighbors, joined through it) are each run through the route and the real gate, timed, and recorded when `NBX_PATHS_RECORD` names a file.
 * The assertions are the bounds, not the figures: every request ends inside the source timeout and its rollback wait, and what it answers is one of the answers the route defines.
 */
import { appendFileSync, rmSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { pathsResponseSchema } from '@neburyx/contracts';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { createLogger } from '../../logger.js';
import { memoryAppStore } from '../app-store.js';
import { ENTITIES, hubOf, RELATIONSHIPS } from '../benchmark/fixture.js';
import { SIZES } from '../benchmark/plan.js';
import { startRig, stopRig, type Rig } from '../benchmark/rig.js';
import { NEO4J_SERIES, sourceFor } from '../neo4j-server.js';
import { makeWebRoot } from '../web-root.js';

const webRoot = makeWebRoot();
let rig: Rig;
let app: Awaited<ReturnType<typeof buildApp>>;

/** The source timeout (5 s) plus the longest wait of the end of a read for its rollback (1 s, `ROLLBACK_WAIT_MS` of the executor; the answer is given before that cleanup starts): no request may take longer. */
const SOURCE_TIMEOUT_MS = 5000;
const ROLLBACK_WAIT_MS = 1000;

beforeAll(async () => {
  rig = await startRig();
  const mapping = { sources: [sourceFor(rig.server, { entities: ENTITIES, relationships: RELATIONSHIPS })] };
  app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping, gate: rig.parts.gate });
}, 3_600_000);

afterAll(async () => {
  await app?.close();
  rmSync(webRoot, { recursive: true, force: true });
  await stopRig(rig);
});

interface Outcome {
  readonly status: number;
  readonly answer: string;
  readonly ms: number;
  readonly paths: number;
  readonly estimate?: string;
  readonly capReached?: boolean;
  readonly partial?: boolean;
}

async function ask(name: string, size: number, body: Record<string, unknown>): Promise<Outcome> {
  const started = performance.now();
  const response = await app.inject({ method: 'POST', url: '/v1/graph/paths', payload: { sourceId: 'graph', relTypes: ['TIED'], maxHops: 2, limit: 25, ...body } });
  const ms = Math.round(performance.now() - started);
  const parsed = response.statusCode === 200 ? pathsResponseSchema.parse(response.json()) : undefined;
  const error = errorBodySchema.safeParse(response.json());
  const outcome: Outcome =
    parsed === undefined
      ? { status: response.statusCode, answer: error.success ? error.data.error.code : 'unknown', ms, paths: 0 }
      : parsed.status === 'heavy'
        ? { status: 200, answer: 'heavy', ms, paths: 0, estimate: `${parsed.estimate.quality} ${parsed.estimate.value ?? ''}` }
        : { status: 200, answer: parsed.partial ? 'partial' : 'ok', ms, paths: parsed.paths.length, capReached: parsed.capReached, partial: parsed.partial, ...(parsed.estimate === undefined ? {} : { estimate: `${parsed.estimate.quality} ${parsed.estimate.value ?? ''}` }) };
  const record = process.env['NBX_PATHS_RECORD'];
  if (record !== undefined && record !== '') appendFileSync(record, `${JSON.stringify({ name, size, ...outcome })}\n`);
  expect(ms).toBeLessThan(SOURCE_TIMEOUT_MS + ROLLBACK_WAIT_MS);
  return outcome;
}

const errorBodySchema = z.object({ error: z.object({ code: z.string() }) });

const hubEnd = (size: number) => ({ entityType: 'hub', stableId: hubOf(size) });
const leaf = (size: number, index: number) => ({ entityType: 'leaf', stableId: `${hubOf(size)}-${index}` });

describe(`the shortest-paths run on a supernode on ${NEO4J_SERIES}`, () => {
  it.each(SIZES)('stops as heavy, from the probe alone, when an end is the supernode of %i relationships, and continues at 25', async (size) => {
    const stopped = await ask('end-is-supernode', size, { from: hubEnd(size), to: leaf(size, 1) });
    expect(stopped).toMatchObject({ status: 200, answer: 'heavy', paths: 0 });
    expect(stopped.estimate).toBe('lowerBound 500');
    const continued = await ask('end-is-supernode:continue', size, { from: hubEnd(size), to: leaf(size, 1), continue: true });
    expect(['ok', 'partial', 'QUERY_TIMEOUT']).toContain(continued.answer);
    expect(continued.paths).toBeLessThanOrEqual(25);
    if (continued.partial === true) expect(continued.capReached).toBe(false);
  }, 120_000);

  it.each(SIZES)('answers, labels as partial or times out, a search through the supernode of %i relationships that no probe of the two ends can see', async (size) => {
    const through = await ask('through-supernode', size, { from: leaf(size, 1), to: leaf(size, 2) });
    expect(['ok', 'partial', 'QUERY_TIMEOUT']).toContain(through.answer);
    if (through.answer === 'ok') expect(through.paths).toBeGreaterThan(0);
    if (through.answer === 'partial') expect(through.paths).toBeGreaterThan(0);
  }, 120_000);

  it('refuses a request beyond the bounds before reading, at the largest supernode', async () => {
    const refused = await ask('beyond-bounds', 100_000, { from: hubEnd(100_000), to: leaf(100_000, 1), maxHops: 9 });
    expect(refused).toMatchObject({ status: 422, answer: 'QUERY_BUDGET_EXCEEDED' });
    expect(refused.ms).toBeLessThan(500);
  });
});
