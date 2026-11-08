import { rmSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { ENTITY_LOAD_ID } from '../gate/templates/entity-load.js';
import { EXPAND_NEIGHBORS_ID } from '../gate/templates/expand-neighbors.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { memoryAppStore } from '../testing/app-store.js';
import { entityRows } from '../testing/entity-fixtures.js';
import { TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { plainNode, plainRelationship } from '../testing/normalize-fixtures.js';
import { onlineIndexesOf, schemaAnswer, withSchema } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';
import { createRequestLimiter } from './request-limiter.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const LIMIT = 2;

const mapping = parseMapping(
  fileOf(
    baseSource({
      id: 'demo',
      budgets: { requests_per_minute: LIMIT },
      entities: [
        { type: 'hub', label: 'Hub', stable_id: 'hubId' },
        { type: 'leaf', label: 'Leaf', stable_id: 'leafId' },
        { type: 'lonely', label: 'Lonely', stable_id: 'lonelyId' },
      ],
      relationships: [{ type: 'LINKED', from: 'hub', to: 'leaf', stable_id: 'relId' }],
    }),
  ),
  'neburyx.yaml',
);

const hub = plainNode(['Hub'], { hubId: 'H-1' }, 'e-hub');
const leaf = plainNode(['Leaf'], { leafId: 'L-1' }, 'e-leaf');
const expansionRows = [{ a: null, m: leaf, rel: plainRelationship('LINKED', hub, leaf, { relId: 'r1' }, 'rel-1'), phase: 2, ts: null, id: 'r1', rtype: 'LINKED', dir: 'out', ntype: null, flag: null, members: null, first: null }];

async function started() {
  const [source] = mapping.sources;
  if (source === undefined) throw new Error('the mapping has no source');
  const respond = (call: ExecuteCall): Promise<ExecuteOutcome> => {
    if (call.templateId === ENTITY_LOAD_ID) {
      return Promise.resolve(entityRows(call.cypher.includes('Lonely') ? plainNode(['Lonely'], { lonelyId: 'N-1' }) : plainNode(['Hub'], { hubId: 'H-1' })));
    }
    return Promise.resolve({ status: 'rows' as const, rows: call.templateId === EXPAND_NEIGHBORS_ID ? expansionRows : [] });
  };
  const executor = new TestExecutor(withSchema(() => schemaAnswer(onlineIndexesOf(source)), respond));
  const limiter = createRequestLimiter({ startSweep: () => () => undefined });
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping, gate: testSourceGate(mapping, { executor }).gate, limiter });
  const entityLoads = () => executor.calls.filter((call) => call.templateId === ENTITY_LOAD_ID).length;
  return { app, limiter, entityLoads };
}

describe('a request whose service reads an entity for itself', () => {
  it.each([
    ['an expansion whose anchor is read separately', '/v1/graph/expand', { sourceId: 'demo', ref: { entityType: 'hub', stableId: 'H-1' }, neighborTypes: ['leaf'] }],
    ['a degree preview of a type with no mapped relationship', '/v1/graph/preview-expansion', { sourceId: 'demo', ref: { entityType: 'lonely', stableId: 'N-1' } }],
  ])('counts %s once, though it reads the entity inside', async (_name, url, payload) => {
    const { app, limiter, entityLoads } = await started();
    for (let i = 0; i < LIMIT; i += 1) expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(200);
    expect(entityLoads()).toBeGreaterThanOrEqual(LIMIT);
    expect([...limiter.inspect().values()]).toEqual([LIMIT]);
    expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(429);
    await app.close();
  });
});
