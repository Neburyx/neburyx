import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExecuteCall, ExecuteOutcome } from '../../../services/api/src/gate/executor.js';
import { EXPAND_NEIGHBORS_ID } from '../../../services/api/src/gate/templates/expand-neighbors.js';
import { SYSTEM_ID } from '../../../services/api/src/gate/system-principal.js';
import { SLOW_READ } from '../../../services/api/src/testing/neo4j-server.js';
import { leftoversOf, startNeo4jRig, type Neo4jRig } from '../../cancellation-suite/src/neo4j-rig.js';

const BUDGET_MS = 1000;
const READS = 10;
let rig: Neo4jRig;

beforeAll(async () => {
  rig = await startNeo4jRig({ size: 10, timeoutMs: BUDGET_MS });
}, 600_000);

afterAll(async () => {
  if (rig === undefined) return;
  expect(await leftoversOf(rig)).toEqual([]);
}, 600_000);

/** The transactions of this run's database that run the forced slow statement, as the server lists them now. */
async function slowTransactionsListed(): Promise<number> {
  const session = rig.server.admin.session({ database: 'system' });
  try {
    const result = await session.run('SHOW TRANSACTIONS YIELD currentQuery, database WHERE database = $database AND currentQuery CONTAINS $marker RETURN count(*) AS listed', { database: rig.server.database, marker: SLOW_READ.slice(0, 40) });
    return Number(String(result.records[0]?.get('listed')));
  } finally {
    await session.close();
  }
}

describe('ten reads of one person at once on a real Neo4j', () => {
  it('never has more than 2 of their transactions on the server, holds no slot at the end, and serves the next read', async () => {
    rig.slow(true);
    const dataReads = { inFlight: 0, peak: 0 };
    const executor = rig.executor as { execute: (call: ExecuteCall) => Promise<ExecuteOutcome> };
    const original = executor.execute.bind(executor);
    executor.execute = async (call) => {
      if (call.templateId !== EXPAND_NEIGHBORS_ID) return original(call);
      dataReads.inFlight += 1;
      dataReads.peak = Math.max(dataReads.peak, dataReads.inFlight);
      try {
        return await original(call);
      } finally {
        dataReads.inFlight -= 1;
      }
    };
    const codes: string[] = [];
    const sent = Array.from({ length: READS }, () =>
      rig.client.expandNeighbors({ sourceId: rig.hub.sourceId, ref: { entityType: rig.hub.entityType, stableId: rig.hub.stableId }, neighborTypes: ['leaf'], direction: 'both' }).then((result) => void codes.push(result.ok ? 'ok' : result.failure.code)),
    );
    let peakListed = 0;
    let peakHeld = 0;
    const everyAnswered = Promise.all(sent).then(() => true);
    // the observation ends when the answers are in
    for (let finished = false; !finished; ) {
      const listed = await slowTransactionsListed();
      peakListed = Math.max(peakListed, listed);
      peakHeld = Math.max(peakHeld, ...[...rig.slots.inspect().users].filter(([key]) => !key.includes(SYSTEM_ID)).map(([, pool]) => pool.held));
      expect(listed).toBeLessThanOrEqual(2);
      finished = await Promise.race([everyAnswered, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10))]);
    }
    expect(dataReads.peak).toBeLessThanOrEqual(2);
    expect(dataReads.peak).toBeGreaterThanOrEqual(1);
    expect(peakHeld).toBeLessThanOrEqual(2);
    expect(dataReads.inFlight).toBe(0);
    // a read either reached the server and ran to its budget, or found no slot within the wait and never reached it: the two add up to the ten, however fast the server is
    expect(codes).toHaveLength(READS);
    expect(codes.every((code) => code === 'QUERY_TIMEOUT' || code === 'SOURCE_BUSY')).toBe(true);
    expect(rig.executor.calls.filter((call) => call.templateId === EXPAND_NEIGHBORS_ID)).toHaveLength(codes.filter((code) => code === 'QUERY_TIMEOUT').length);
    expect(rig.slots.inspect().users.size).toBe(0);
    expect(rig.slots.inspect().sources.size).toBe(0);
    rig.slow(false);
    expect(await rig.client.expandNeighbors({ sourceId: rig.hub.sourceId, ref: { entityType: rig.hub.entityType, stableId: rig.hub.stableId }, neighborTypes: ['leaf'], direction: 'both' })).toMatchObject({ ok: true });
  });
});
