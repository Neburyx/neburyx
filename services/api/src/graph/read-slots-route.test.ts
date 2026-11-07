import { rmSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { EXPAND_NEIGHBORS_ID } from '../gate/templates/expand-neighbors.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { communitySeams } from '../seams/community-seams.js';
import type { AuditEvent } from '../seams/seams.js';
import { memoryAppStore } from '../testing/app-store.js';
import { entityRows } from '../testing/entity-fixtures.js';
import { plainNode, plainRelationship } from '../testing/normalize-fixtures.js';
import { TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { onlineIndexesOf, schemaAnswer, withSchema } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const QUEUE_WAIT_MS = 150;

const mapping = parseMapping(
  fileOf(
    baseSource({
      id: 'demo',
      budgets: { user_concurrency: 1, queue_wait_ms: QUEUE_WAIT_MS },
      entities: [
        { type: 'hub', label: 'Hub', stable_id: 'hubId' },
        { type: 'leaf', label: 'Leaf', stable_id: 'leafId' },
      ],
      relationships: [{ type: 'LINKED', from: 'hub', to: 'leaf', stable_id: 'relId' }],
    }),
  ),
  'neburyx.yaml',
);

const hub = plainNode(['Hub'], { hubId: 'H-1' }, 'e-hub');
const leaf = plainNode(['Leaf'], { leafId: 'L-1' }, 'e-leaf');
const rows = [{ a: hub, m: leaf, rel: plainRelationship('LINKED', hub, leaf, { relId: 'r1' }, 'rel-1'), phase: 2, ts: null, id: 'r1', rtype: 'LINKED', dir: 'out', ntype: null, flag: null, members: null, first: null }];

/** An executor whose first expansion read is held until the test lets it go. */
function heldExecutor() {
  let letGo: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    letGo = resolve;
  });
  let expansions = 0;
  const [source] = mapping.sources;
  if (source === undefined) throw new Error('the mapping has no source');
  const respond = async (call: ExecuteCall): Promise<ExecuteOutcome> => {
    if (call.templateId === 'entity-load') return entityRows(plainNode(['Hub'], { hubId: 'H-1' }));
    if (call.templateId === EXPAND_NEIGHBORS_ID && ++expansions === 1) await gate;
    return { status: 'rows', rows };
  };
  const executor = new TestExecutor(withSchema(() => schemaAnswer(onlineIndexesOf(source)), respond));
  return { executor, letGo: () => letGo(), expansionsRead: () => executor.calls.filter((call) => call.templateId === EXPAND_NEIGHBORS_ID).length };
}

async function started() {
  const held = heldExecutor();
  const events: AuditEvent[] = [];
  const defaults = communitySeams();
  const seams = { policy: defaults.policy, coordinator: defaults.coordinator, audit: { record: (event: AuditEvent) => (events.push(event), Promise.resolve()) } };
  const parts = testSourceGate(mapping, { executor: held.executor, seams });
  const logs: string[] = [];
  const app = await buildApp({ webRoot, logger: createLogger({ write: (line: string) => void logs.push(line) }), store: memoryAppStore(), mapping, gate: parts.gate, seams });
  return { app, events, logs, ...held };
}

const expand = (app: Awaited<ReturnType<typeof started>>['app']) =>
  app.inject({ method: 'POST', url: '/v1/graph/expand', payload: { sourceId: 'demo', ref: { entityType: 'hub', stableId: 'H-1' }, neighborTypes: ['leaf'] } });

describe('a person with their one read slot held by an expansion', () => {
  it('answers a second expansion SOURCE_BUSY after the wait, with nothing read for it, and audits it failed', async () => {
    const { app, events, logs, letGo, expansionsRead } = await started();
    const first = expand(app);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const startedAt = Date.now();
    const second = await expand(app);
    const waited = Date.now() - startedAt;
    expect(second.statusCode).toBe(503);
    expect(second.json()).toMatchObject({ error: { code: 'SOURCE_BUSY', retryable: true } });
    expect(second.json().error.details).toBeUndefined();
    expect(waited).toBeGreaterThanOrEqual(QUEUE_WAIT_MS - 5);
    expect(waited).toBeLessThan(QUEUE_WAIT_MS + 100);
    expect(expansionsRead()).toBe(1);
    letGo();
    expect((await first).statusCode).toBe(200);
    const expandEvents = events.filter((event) => event.action === 'graph.expand');
    expect(expandEvents.map((event) => event.result).sort()).toEqual(['failed', 'success']);
    expect(logs.join('\n')).not.toContain('H-1');
    await app.close();
  });

  it('answers the second expansion 200 when the first ends within the wait', async () => {
    const { app, letGo, expansionsRead } = await started();
    const first = expand(app);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = expand(app);
    await new Promise((resolve) => setTimeout(resolve, QUEUE_WAIT_MS / 3));
    letGo();
    expect((await first).statusCode).toBe(200);
    expect((await second).statusCode).toBe(200);
    expect(expansionsRead()).toBe(2);
    await app.close();
  });
});
