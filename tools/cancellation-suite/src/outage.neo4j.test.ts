import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXPAND_NEIGHBORS_ID } from '../../../services/api/src/gate/templates/expand-neighbors.js';
import { pollUntil, transactionIsListed } from '../../../services/api/src/testing/neo4j-server.js';
import { leftoversOf, startNeo4jRig, type Neo4jRig } from './neo4j-rig.js';
import { personalise } from './rig.js';

const BUDGET_MS = 1000;
let rig: Neo4jRig;

/** A rig of its own for each case; the outage case keeps the product's default budget, since a budget chosen to force a timeout is not the one an outage case should be read under. */
function ownRig(timeoutMs: number | undefined, size: number): void {
  beforeAll(async () => {
    rig = await startNeo4jRig({ size, timeoutMs });
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
    const asked = rig.expand.expand(rig.hub, ['leaf']);
    expect(await asked).toBe('failed');
    expect(last()).toMatchObject({ status: 504, body: { error: { code: 'QUERY_TIMEOUT', retryable: true, details: { timeoutMs: BUDGET_MS } } } });
    expect(rig.snapshot()).toBe(before);
    expect(await pollUntil(async () => !(await transactionIsListed(rig.server, traceOfRead())), BUDGET_MS, 25)).toBe(true);
    await pollUntil(() => Promise.resolve(rig.slots.inspect().sources.size === 0), 5000, 25);
    expect(rig.slots.inspect().sources.size).toBe(0);
    rig.slow(false);
    const next = await rig.expand.expand(rig.hub, ['leaf']);
    await annotate(`the next read: ${next} ${JSON.stringify(last()?.body).slice(0, 400)}`);
    expect(next).toBe('sent');
  });
});
