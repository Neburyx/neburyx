import { rmSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { ExecuteOutcome } from '../gate/executor.js';
import { EXPAND_NEIGHBORS_ID } from '../gate/templates/expand-neighbors.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { communitySeams } from '../seams/community-seams.js';
import type { Coordinator, Seams } from '../seams/seams.js';
import { memoryAppStore } from '../testing/app-store.js';
import { entityRows } from '../testing/entity-fixtures.js';
import { TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { plainNode } from '../testing/normalize-fixtures.js';
import { onlineIndexesOf, schemaAnswer, withSchema } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const mapping = parseMapping(
  fileOf(
    baseSource({
      id: 'demo',
      budgets: { breaker_failures: 2, breaker_cooldown_ms: 30_000 },
      entities: [
        { type: 'hub', label: 'Hub', stable_id: 'hubId' },
        { type: 'leaf', label: 'Leaf', stable_id: 'leafId' },
      ],
      relationships: [{ type: 'LINKED', from: 'hub', to: 'leaf', stable_id: 'relId' }],
    }),
  ),
  'neburyx.yaml',
);
const [source] = mapping.sources;
if (source === undefined) throw new Error('the mapping has no source');

async function started(seams?: (defaults: Seams) => Seams) {
  const defaults = communitySeams();
  const given = seams?.(defaults) ?? defaults;
  const timeout: ExecuteOutcome = { status: 'timeout' };
  const executor = new TestExecutor(withSchema(() => schemaAnswer(onlineIndexesOf(source)), (call) => Promise.resolve(call.templateId === EXPAND_NEIGHBORS_ID ? timeout : entityRows(plainNode(['Hub'], { hubId: 'H-1' })))));
  const parts = testSourceGate(mapping, { executor, seams: given });
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping, gate: parts.gate, seams: given });
  return { app, executor };
}

const expand = (app: Awaited<ReturnType<typeof started>>['app']) =>
  app.inject({ method: 'POST', url: '/v1/graph/expand', payload: { sourceId: 'demo', ref: { entityType: 'hub', stableId: 'H-1' }, neighborTypes: ['leaf'] } });

describe('a source whose reads keep timing out', () => {
  it('answers 503 SOURCE_UNAVAILABLE with the reason, the wait and a Retry-After header, and reads nothing for it', async () => {
    const { app, executor } = await started();
    expect((await expand(app)).statusCode).toBe(504);
    expect((await expand(app)).statusCode).toBe(504);
    const reads = executor.calls.length;
    const refused = await expand(app);
    expect(refused.statusCode).toBe(503);
    expect(refused.json()).toMatchObject({ error: { code: 'SOURCE_UNAVAILABLE', retryable: true, message: 'The source has timed out repeatedly and is being left to recover. Try again shortly.', details: { reason: 'repeated-timeouts' } } });
    const wait = refused.json().error.details.retryAfterMs as number;
    expect(wait).toBeGreaterThan(29_000);
    expect(wait).toBeLessThanOrEqual(30_000);
    expect(refused.headers['retry-after']).toBe(String(Math.ceil(wait / 1000)));
    expect(executor.calls).toHaveLength(reads);
    await app.close();
  });
});

describe('any other unavailable source', () => {
  it('sends no wait and no Retry-After header, even when the coordinator names one', async () => {
    const refusing = (defaults: Seams): Seams => ({ ...defaults, coordinator: { acquireRead: () => Promise.resolve({ status: 'unavailable', retryAfterMs: 5000 }) } satisfies Coordinator });
    const { app } = await started(refusing);
    const answer = await expand(app);
    expect(answer.statusCode).toBe(503);
    expect(answer.json().error.details).toEqual({ reason: 'unreachable' });
    expect(answer.headers['retry-after']).toBeUndefined();
    await app.close();
  });
});
