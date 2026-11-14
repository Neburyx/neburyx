/*
 * The shortest-paths run on a layered graph made to be slow for a shortest-path search: one start, three layers of 100 entities, one end, every entity joined to every entity of the next layer, so that the
 * 4-hop routes from the start to the end are all of one length and there are a million of them. The run asks for 25. The source's own timeout is lowered step by step, after a warm-up request has opened the
 * connection, and each answer, its time and the number of paths are recorded when `NBX_PATHS_RECORD` names a file. The assertions are the bounds, not the figures.
 */
import { appendFileSync, rmSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { pathsResponseSchema } from '@neburyx/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from '../../app.js';
import { createSourceGate, type SourceGate } from '../../gate/source-gate.js';
import { createLogger } from '../../logger.js';
import { communitySeams } from '../../seams/community-seams.js';
import { memoryAppStore } from '../app-store.js';
import { envFor, NEO4J_SERIES, runAdmin, sourceFor, startNeo4j, type RunningNeo4j } from '../neo4j-server.js';
import { makeWebRoot } from '../web-root.js';

const WIDTH = 100;
const ROLLBACK_WAIT_MS = 1000;
const entities = [{ type: 'step', label: 'LayerStep', stable_id: 'stepId' }];
const relationships = [{ type: 'NEXT', from: 'step', to: 'step', stable_id: 'nextId' }];
const webRoot = makeWebRoot();
const opened: SourceGate[] = [];
let server: RunningNeo4j;

beforeAll(async () => {
  server = await startNeo4j();
  await runAdmin(server, 'CREATE CONSTRAINT layer_step FOR (n:LayerStep) REQUIRE n.stepId IS UNIQUE');
  await runAdmin(server, `UNWIND ['start', 'end'] + [x IN range(0, ${3 * WIDTH - 1}) | 'l' + toString(1 + x / ${WIDTH}) + '-' + toString(1 + x % ${WIDTH})] AS id CREATE (:LayerStep {stepId: id})`);
  await runAdmin(server, `MATCH (s:LayerStep {stepId: 'start'}), (a:LayerStep) WHERE a.stepId STARTS WITH 'l1-' CREATE (s)-[:NEXT {nextId: 's-' + a.stepId}]->(a)`);
  for (const [from, to] of [['l1-', 'l2-'], ['l2-', 'l3-']] as const) {
    await runAdmin(server, `MATCH (a:LayerStep), (b:LayerStep) WHERE a.stepId STARTS WITH '${from}' AND b.stepId STARTS WITH '${to}' CREATE (a)-[:NEXT {nextId: a.stepId + '>' + b.stepId}]->(b)`);
  }
  await runAdmin(server, `MATCH (c:LayerStep), (e:LayerStep {stepId: 'end'}) WHERE c.stepId STARTS WITH 'l3-' CREATE (c)-[:NEXT {nextId: c.stepId + '>end'}]->(e)`);
  await runAdmin(server, 'CALL db.awaitIndexes(300)');
}, 1_800_000);

afterAll(async () => {
  await Promise.all(opened.map((parts) => parts.close()));
  rmSync(webRoot, { recursive: true, force: true });
  await server?.stop();
});

const errorBodySchema = z.object({ error: z.object({ code: z.string(), details: z.object({ reason: z.string().optional() }).optional() }) });
const step = (stableId: string) => ({ entityType: 'step', stableId });

async function runAt(timeoutMs: number): Promise<{ answer: string; ms: number; warmedUp: string }> {
  const defaults = communitySeams();
  const mapping = { sources: [sourceFor(server, { entities, relationships, budgets: { timeout_ms: timeoutMs } })] };
  const parts = createSourceGate({ mapping, env: envFor(server), seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit }, logger: { warn: () => undefined } });
  opened.push(parts);
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping, gate: parts.gate });
  const ask = (to: string, maxHops: number) => app.inject({ method: 'POST', url: '/v1/graph/paths', payload: { sourceId: 'graph', from: step('start'), to: step(to), relTypes: ['NEXT'], maxHops, limit: 25, continue: true } });
  try {
    const warm = await ask('l1-1', 1);
    const started = performance.now();
    const response = await ask('end', 4);
    const ms = Math.round(performance.now() - started);
    const ok = response.statusCode === 200 ? pathsResponseSchema.parse(response.json()) : undefined;
    const error = errorBodySchema.safeParse(response.json());
    const answer = ok !== undefined && ok.status === 'ok' ? (ok.partial ? 'partial' : 'ok') : error.success ? error.data.error.code : 'unknown';
    const record = process.env['NBX_PATHS_RECORD'];
    if (record !== undefined && record !== '') {
      const detail = { name: 'layered', timeoutMs, warmUpStatus: warm.statusCode, status: response.statusCode, answer, ms, ...(ok !== undefined && ok.status === 'ok' ? { paths: ok.paths.length, capReached: ok.capReached, retained: ok.retained, requested: ok.requested } : {}), ...(error.success ? { reason: error.data.error.details?.reason } : {}) };
      appendFileSync(record, `${JSON.stringify(detail)}\n`);
    }
    return { answer, ms, warmedUp: String(warm.statusCode) };
  } finally {
    await app.close();
  }
}

describe(`the shortest-paths run on a layered graph of a million equal routes on ${NEO4J_SERIES}`, () => {
  it.each([5000, 2000, 500, 100, 40, 20])('ends inside the source timeout of %i ms plus the rollback wait, with its paths, labelled partial, or with an error, never a hang', async (timeoutMs) => {
    const { answer, ms } = await runAt(timeoutMs);
    expect(['ok', 'partial', 'QUERY_TIMEOUT', 'SOURCE_UNAVAILABLE']).toContain(answer);
    expect(ms).toBeLessThan(timeoutMs + ROLLBACK_WAIT_MS + 500);
  }, 120_000);
});
