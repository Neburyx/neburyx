import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { windowRequestOf } from '../../../apps/web/src/api/expand-window.js';
import { EXPAND_NEIGHBORS_ID } from '../../../services/api/src/gate/templates/expand-neighbors.js';
import { pollUntil, transactionIsListed } from '../../../services/api/src/testing/neo4j-server.js';
import { ceilingOf, serverLag, timeOneRead, timeOvershoot, warmUp } from '../../../services/api/src/testing/read-latency.js';
import { leftoversOf, startNeo4jRig, type Neo4jRig } from './neo4j-rig.js';
import { personalise } from './rig.js';

const BUDGET_MS = 1000;
let rig: Neo4jRig;
let ceilingMs = 0;
let ceilingNote = '';
const expansion = () => ({ sourceId: rig.hub.sourceId, ref: { entityType: rig.hub.entityType, stableId: rig.hub.stableId }, neighborTypes: ['leaf'], direction: 'both' as const });
const expandOnce = () => rig.client.expandNeighbors(expansion());
/** The read the web client's expansion of the hub asks for: the same, in the window the store gives the node, which makes it another statement. */
const expandAsTheStore = () => rig.client.expandNeighbors({ ...expansion(), ...windowRequestOf(rig.expand.windowOf(rig.hub)) });
const statements = (): readonly string[] => rig.executor.calls.filter((call) => call.templateId === EXPAND_NEIGHBORS_ID).map((call) => call.cypher);
let warmed: readonly string[] = [];

/** A rig of its own for each case; the outage case keeps the product's default budget, since a budget chosen to force a timeout is not the one an outage case should be read under. */
function ownRig(timeoutMs: number | undefined, size: number): void {
  beforeAll(async () => {
    rig = await startNeo4jRig({ size, timeoutMs });
    // an ordinary read and the lag of the server set the ceiling of a forced timeout; the outage case forces none and counts its own requests
    if (timeoutMs !== undefined) {
      // every statement a case later reads as an ordinary one is planned, outside the budget, before the timed part
      await rig.planning(async () => {
        await warmUp('the expansion', expandOnce);
        await warmUp("the expansion in the store's window", expandAsTheStore);
      });
      warmed = statements();
      const read = await timeOneRead(expandOnce);
      const lag = await serverLag(rig.server.admin, async () => {
        rig.slow(true);
        try {
          return await timeOvershoot(timeoutMs, expandOnce);
        } finally {
          rig.slow(false);
        }
      });
      // the timed reads' slots are released before the case counts its own
      expect(await pollUntil(() => Promise.resolve(rig.slots.inspect().sources.size === 0), 5000, 25)).toBe(true);
      ceilingMs = ceilingOf(timeoutMs, lag.lagMs, read);
      ceilingNote = `ceiling ${ceilingMs} ms: ordinary read ${read} ms, server lag ${lag.lagMs} ms from the ${lag.via}`;
    }
  }, 600_000);

  afterAll(async () => {
    if (rig === undefined) return;
    expect(await leftoversOf(rig)).toEqual([]);
  }, 600_000);
}

const last = () => rig.responses[rig.responses.length - 1];
const traceOfRead = (): string => rig.executor.calls.filter((call) => call.templateId === EXPAND_NEIGHBORS_ID).at(-1)?.traceId ?? '';

describe('the source port closed in the middle of a read', () => {
  ownRig(undefined, 1000);

  it('answers SOURCE_UNAVAILABLE as retryable, leaves the client as it was, and a retry merges the page once the port is open', async ({ annotate }) => {
    rig.slow(true);
    const baseline = rig.state.loadedGraph().nodes.length;
    const before = rig.snapshot();
    const asked = rig.expand.expand(rig.hub, ['leaf']);
    expect(await pollUntil(async () => transactionIsListed(rig.server, traceOfRead()), 3000, 5)).toBe(true);
    await rig.forwarder.stop();
    expect(await asked).toBe('failed');
    await annotate(`observed: ${JSON.stringify(last()?.body)}`);
    expect(last()).toMatchObject({ body: { error: { code: 'SOURCE_UNAVAILABLE', retryable: true, details: { reason: 'unreachable' } } } });
    expect(rig.state.loadedGraph().nodes.length).toBe(baseline);
    expect(rig.snapshot()).toBe(before);
    await rig.forwarder.resume();
    rig.slow(false);
    rig.banner.view.getState().banner?.actions.find((each) => each.id === 'retry')?.run();
    // the dev server is shared and may be busy: the bound is a ceiling for the retry to be answered, not the time it takes
    await pollUntil(() => Promise.resolve(rig.state.loadedGraph().nodes.length > baseline), 30_000, 25);
    await annotate(`after the retry: ${JSON.stringify(rig.responses.slice(-2).map((r) => [r.status, (r.body as { error?: { code?: string; details?: unknown } }).error]))} banner ${JSON.stringify(rig.showing())}`);
    expect(rig.state.loadedGraph().nodes.length).toBeGreaterThan(baseline);
    expect(rig.requests.filter((request) => request.includes('/v1/graph/expand'))).toHaveLength(2);
  });
});

describe('a read forced past a 1,000 ms budget, through the API and the real adapter', () => {
  ownRig(BUDGET_MS, 10);

  it('answers QUERY_TIMEOUT naming 1,000 ms, leaves the client as it was, lists no transaction of the read on the server, and the source serves the next read', async ({ annotate }) => {
    rig.slow(true);
    personalise(rig);
    const before = rig.snapshot();
    const started = Date.now();
    const asked = rig.expand.expand(rig.hub, ['leaf']);
    expect(await asked).toBe('failed');
    const elapsed = Date.now() - started;
    await annotate(`the forced read was answered in ${elapsed} ms (${ceilingNote})`);
    expect(elapsed).toBeGreaterThanOrEqual(BUDGET_MS);
    expect(elapsed).toBeLessThan(ceilingMs);
    expect(last()).toMatchObject({ status: 504, body: { error: { code: 'QUERY_TIMEOUT', retryable: true, details: { timeoutMs: BUDGET_MS } } } });
    expect(rig.snapshot()).toBe(before);
    expect(await pollUntil(async () => !(await transactionIsListed(rig.server, traceOfRead())), BUDGET_MS, 25)).toBe(true);
    await pollUntil(() => Promise.resolve(rig.slots.inspect().sources.size === 0), 5000, 25);
    expect(rig.slots.inspect().sources.size).toBe(0);
    rig.slow(false);
    const next = await rig.expand.expand(rig.hub, ['leaf']);
    await annotate(`the next read: ${next} ${JSON.stringify(last()?.body).slice(0, 400)}`);
    expect(next).toBe('sent');
    expect(warmed, 'the next read ran a statement that was warmed up').toContain(statements().at(-1));
  });
});
