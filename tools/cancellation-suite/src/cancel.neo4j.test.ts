import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXPAND_NEIGHBORS_ID } from '../../../services/api/src/gate/templates/expand-neighbors.js';
import { pollUntil, transactionIsListed, waitUntilNotListed } from '../../../services/api/src/testing/neo4j-server.js';
import { leftoversOf, startNeo4jRig, type Neo4jRig } from './neo4j-rig.js';
import { personalise } from './rig.js';

const SIZE = 100_000;
let rig: Neo4jRig;

beforeAll(async () => {
  rig = await startNeo4jRig({ size: SIZE });
}, 3_600_000);

afterAll(async () => {
  if (rig === undefined) return;
  expect(await leftoversOf(rig)).toEqual([]);
});

describe('cancelling an expansion of a node of 100,000 relationships on a real Neo4j', () => {
  it('ends the transaction on the server, holds no slot, leaves the client as it was, and serves the next read', async ({ annotate }) => {
    personalise(rig);
    const before = rig.snapshot();
    const asked = rig.expand.expand(rig.hub, ['leaf']);
    const expandCall = (): string | undefined => rig.executor.calls.find((call) => call.templateId === EXPAND_NEIGHBORS_ID)?.traceId;
    expect(await pollUntil(async () => expandCall() !== undefined && (await transactionIsListed(rig.server, expandCall() ?? '')), 5000, 5)).toBe(true);
    const listedAt = performance.now();
    await rig.pressCancel();
    await asked;
    expect(await waitUntilNotListed(rig.server, expandCall() ?? '', 10_000)).toBe(true);
    await annotate(`observed: the transaction was gone ${Math.round(performance.now() - listedAt)} ms after the cancel (polled; not a promise)`);
    expect(rig.snapshot()).toBe(before);
    await pollUntil(() => Promise.resolve(rig.slots.inspect().sources.size === 0 && rig.slots.inspect().users.size === 0), 5000, 25);
    expect(rig.slots.inspect().sources.size).toBe(0);
    expect(rig.slots.inspect().users.size).toBe(0);
    expect(rig.events.find((event) => event.action === 'graph.expand')).toMatchObject({ result: 'failed', detail: { reason: 'cancelled' } });
    const next = rig.expand.expand(rig.hub, ['leaf']);
    expect(await next).toBe('sent');
    expect(rig.state.loadedGraph().nodes.length).toBeGreaterThan(rig.loaded.nodes.length);
  });
});
