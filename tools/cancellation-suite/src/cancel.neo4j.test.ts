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

const LINKED_OUT = { relationshipTypes: ['LINKED'], direction: 'out', arrivesAt: 'leaf' };
const LINKED_BACK = { relationshipTypes: ['LINKED'], direction: 'in', arrivesAt: 'hub' };
const KINDS: readonly (readonly [string, readonly Record<string, unknown>[]])[] = [
  ['a fan', [{ ...LINKED_OUT, fan: { atLeast: 3 } }]],
  ['a time order', [LINKED_OUT, { ...LINKED_BACK, after: 'previous' }]],
  ['a cycle', [LINKED_OUT, { ...LINKED_BACK, closesAtAnchor: true }]],
];

describe.each(KINDS)('cancelling the estimate of a pattern run with %s on a real Neo4j', (_kind, steps) => {
  it('ends the transaction on the server, holds no slot, records the run as cancelled and serves the next read (the statement of the read is the slow read of the Neo4j tests, as for the expansion: the adapter, the session and the abort are the real ones)', async ({ annotate }) => {
    rig.slow(true);
    const seen = rig.executor.calls.length;
    const controller = new AbortController();
    const body = JSON.stringify({ sourceId: rig.hub.sourceId, definition: { anchorType: 'hub', steps }, anchor: { entityType: 'hub', stableId: rig.hub.stableId } });
    const sent = fetch(`${rig.base}/v1/patterns/run`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `cancel-real-pattern-${_kind.replaceAll(' ', '-')}` }, body, signal: controller.signal }).catch(() => undefined);
    const countCall = (): string | undefined => rig.executor.calls.slice(seen).find((call) => call.templateId === 'pattern-count')?.traceId;
    expect(await pollUntil(async () => countCall() !== undefined && (await transactionIsListed(rig.server, countCall() ?? '')), 8000, 5)).toBe(true);
    const listedAt = performance.now();
    controller.abort();
    await sent;
    expect(await waitUntilNotListed(rig.server, countCall() ?? '', 10_000)).toBe(true);
    await annotate(`observed: the transaction was gone ${Math.round(performance.now() - listedAt)} ms after the abort (polled; not a promise)`);
    await pollUntil(() => Promise.resolve(rig.slots.inspect().sources.size === 0 && rig.slots.inspect().users.size === 0), 5000, 25);
    expect(rig.slots.inspect().sources.size).toBe(0);
    expect(rig.slots.inspect().users.size).toBe(0);
    expect(rig.events.find((event) => event.action === 'pattern.count')).toMatchObject({ result: 'failed', detail: { reason: 'cancelled' } });
    expect(rig.executor.calls.slice(seen).some((call) => call.templateId === 'pattern')).toBe(false);
    rig.slow(false);
  });
});

describe.each(KINDS)('the real statement of a pattern run with %s from a node of 100,000 relationships', (kind, steps) => {
  it('is bounded: it answers within the read timeout, reads at most the count cap, and is a lower bound or a heavy stop and never an exact count of 100,000', async () => {
    rig.slow(false);
    const body = JSON.stringify({ sourceId: rig.hub.sourceId, definition: { anchorType: 'hub', steps }, anchor: { entityType: 'hub', stableId: rig.hub.stableId } });
    const started = performance.now();
    const answer = await fetch(`${rig.base}/v1/patterns/run`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `bounded-real-pattern-${kind.replaceAll(' ', '-')}` }, body });
    expect(answer.status).toBe(200);
    const json = (await answer.json()) as { status: string; count?: { value: number; quality: string }; estimate?: { value: number; quality: string } };
    expect(performance.now() - started).toBeLessThan(5000);
    expect(['ok', 'heavy']).toContain(json.status);
    const shown = json.status === 'ok' ? json.count : json.estimate;
    expect(shown?.value ?? 0).toBeLessThanOrEqual(501);
    if (shown !== undefined && shown.value > 0) expect(shown.quality).not.toBe('exact');
  });
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
