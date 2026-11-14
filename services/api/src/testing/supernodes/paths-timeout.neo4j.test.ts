/*
 * The shortest-paths run when the source timeout is forced low: a search through the supernode of 10,000 relationships (many shortest paths over four relationship types) and a search between a neighbour of
 * that supernode and a neighbour of a second supernode of 100,000 relationships, with no path within the hop count (each side of the search has a large frontier to expand). A warm-up request opens the connection
 * first. Each answer, its time and, for an error, its reason are recorded when `NBX_PATHS_RECORD` names a file, with the events the executor logged for it (no query, value or address). The assertions are the
 * bounds: every request ends inside the source timeout and the rollback wait, and what it answers is an answer the route defines or the source's own unavailable answer.
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
import { ENTITIES, hubOf, RELATIONSHIPS } from '../benchmark/fixture.js';
import { startRig, stopRig, type Rig } from '../benchmark/rig.js';
import { envFor, NEO4J_SERIES, sourceFor } from '../neo4j-server.js';
import { makeWebRoot } from '../web-root.js';

const SIZE = 10_000;
const OTHER_SIZE = 100_000;
const ROLLBACK_WAIT_MS = 1000;
const ALL = ['LINKED', 'TIED', 'NOTED', 'PAID'];
const webRoot = makeWebRoot();
const opened: SourceGate[] = [];
let rig: Rig;

beforeAll(async () => {
  rig = await startRig({ sizes: [SIZE, OTHER_SIZE] });
}, 1_800_000);

afterAll(async () => {
  await Promise.all(opened.map((parts) => parts.close()));
  rmSync(webRoot, { recursive: true, force: true });
  await stopRig(rig);
});

const errorBodySchema = z.object({ error: z.object({ code: z.string(), details: z.object({ reason: z.string().optional() }).optional() }) });
const leaf = (index: number, size = SIZE) => ({ entityType: 'leaf', stableId: `${hubOf(size)}-${index}` });

async function askWithTimeout(name: string, timeoutMs: number, to: { entityType: string; stableId: string }, maxHops: number): Promise<{ answer: string; ms: number }> {
  const defaults = communitySeams();
  const logged: { event: unknown; serverCode: unknown }[] = [];
  const mapping = { sources: [sourceFor(rig.server, { entities: ENTITIES, relationships: RELATIONSHIPS, budgets: { timeout_ms: timeoutMs } })] };
  const parts = createSourceGate({ mapping, env: envFor(rig.server), seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit }, logger: { warn: (fields: unknown) => void (typeof fields === 'object' && fields !== null && logged.push({ event: 'event' in fields ? fields.event : undefined, serverCode: 'serverCode' in fields ? fields.serverCode : undefined })) } });
  opened.push(parts);
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping, gate: parts.gate });
  try {
    await app.inject({ method: 'POST', url: '/v1/graph/paths', payload: { sourceId: 'graph', from: leaf(1), to: leaf(2), relTypes: ['TIED'], maxHops: 1, limit: 1, continue: true } });
    const started = performance.now();
    const response = await app.inject({ method: 'POST', url: '/v1/graph/paths', payload: { sourceId: 'graph', from: leaf(1), to, relTypes: ALL, maxHops, limit: 25, continue: true } });
    const ms = Math.round(performance.now() - started);
    const ok = response.statusCode === 200 ? pathsResponseSchema.parse(response.json()) : undefined;
    const error = errorBodySchema.safeParse(response.json());
    const answer = ok !== undefined && ok.status === 'ok' ? (ok.partial ? 'partial' : 'ok') : error.success ? error.data.error.code : 'unknown';
    const record = process.env['NBX_PATHS_RECORD'];
    if (record !== undefined && record !== '') {
      const detail = { name, timeoutMs, status: response.statusCode, answer, ms, ...(ok !== undefined && ok.status === 'ok' ? { paths: ok.paths.length, capReached: ok.capReached, retained: ok.retained, requested: ok.requested } : {}), ...(error.success ? { reason: error.data.error.details?.reason } : {}), logged };
      appendFileSync(record, `${JSON.stringify(detail)}\n`);
    }
    return { answer, ms };
  } finally {
    await app.close();
  }
}

describe(`the shortest-paths run with the source timeout forced low, on ${NEO4J_SERIES}`, () => {
  it.each([1, 3, 5, 10, 20, 50])('ends inside %i ms plus the rollback wait for a search through the supernode, with a result or an error, never a hang', async (timeoutMs) => {
    const { answer, ms } = await askWithTimeout('through-supernode', timeoutMs, leaf(2), 2);
    expect(['ok', 'partial', 'QUERY_TIMEOUT', 'SOURCE_UNAVAILABLE']).toContain(answer);
    expect(ms).toBeLessThan(timeoutMs + ROLLBACK_WAIT_MS + 500);
  }, 120_000);

  it.each([10, 20, 50, 100, 500, 2000])('ends inside %i ms plus the rollback wait for a search between neighbours of two supernodes with no path within four hops, never a hang', async (timeoutMs) => {
    const { answer, ms } = await askWithTimeout('between-two-supernodes', timeoutMs, leaf(1, OTHER_SIZE), 4);
    expect(['ok', 'partial', 'QUERY_TIMEOUT', 'SOURCE_UNAVAILABLE']).toContain(answer);
    expect(ms).toBeLessThan(timeoutMs + ROLLBACK_WAIT_MS + 500);
  }, 120_000);
});
