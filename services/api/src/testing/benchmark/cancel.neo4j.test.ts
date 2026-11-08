import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RequestCancelled } from '../../errors.js';
import { DEGREE_PREVIEW_BOUNDED_ID } from '../../gate/templates/degree-preview.js';
import { EXPAND_NEIGHBORS_ID } from '../../gate/templates/expand-neighbors.js';
import { ENTITY_LOAD_ID } from '../../gate/templates/entity-load.js';
import { SEARCH_EXACT_ID } from '../../gate/templates/search-exact.js';
import type { GateRequest } from '../../gate/types.js';
import { transactionIsListed } from '../neo4j-server.js';
import { gateRequest, LOCAL_PRINCIPAL } from '../gate.js';
import { describeObservation, observeCancel, type CancelObservation, type ReadEnd } from './cancel.js';
import { hubOf } from './fixture.js';
import { startRig, stopRig, type Rig } from './rig.js';

const SIZE = 100_000;
const TIMEOUT_MS = 10_000;
const ATTEMPTS = 5;
let rig: Rig;
let sequence = 0;

beforeAll(async () => {
  rig = await startRig({ sizes: [SIZE], searchable: true });
}, 3_600_000);

afterAll(async () => {
  await stopRig(rig);
});

type Shape = (traceId: string, signal: AbortSignal) => GateRequest;
const base = (traceId: string, signal: AbortSignal, templateId: string, params: object): GateRequest =>
  gateRequest({ traceId, sourceId: 'graph', principal: LOCAL_PRINCIPAL, templateId, params, limit: 25, signal });

const SHAPES: readonly { readonly name: string; readonly request: Shape }[] = [
  { name: 'expand, all four relationship types, first page', request: (traceId, signal) => base(traceId, signal, EXPAND_NEIGHBORS_ID, { entityType: 'hub', stableId: hubOf(SIZE), neighborType: 'leaf', direction: 'both', sort: 'observed' }) },
  { name: 'expand, aggregate relationships, first page', request: (traceId, signal) => base(traceId, signal, EXPAND_NEIGHBORS_ID, { entityType: 'hub', stableId: hubOf(SIZE), neighborType: 'leaf', relTypes: ['NOTED'], direction: 'both', sort: 'observed' }) },
  { name: 'degree preview', request: (traceId, signal) => base(traceId, signal, DEGREE_PREVIEW_BOUNDED_ID, { entityType: 'hub', stableId: hubOf(SIZE) }) },
  { name: 'entity read', request: (traceId, signal) => ({ ...base(traceId, signal, ENTITY_LOAD_ID, { entityType: 'hub', stableId: hubOf(SIZE) }), limit: 1 }) },
  { name: 'search by stable ID', request: (traceId, signal) => base(traceId, signal, SEARCH_EXACT_ID, { text: hubOf(SIZE), targets: [{ entityType: 'hub', property: 'hubId', match: 'value' }] }) },
];

/** Aborts a read of the gate once the server lists its transaction; tries again, up to `ATTEMPTS` times, when the read finished first, and returns every observation. */
async function cancelling(shape: Shape): Promise<readonly CancelObservation[]> {
  const seen: CancelObservation[] = [];
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    let traceId = '';
    const observation = await observeCancel(
      async (signal) => {
        traceId = `trace-cancel-${++sequence}-${Date.now()}`;
        try {
          await rig.parts.gate.run(shape(traceId, signal));
          return 'other' as ReadEnd;
        } catch (error) {
          if (error instanceof RequestCancelled) return 'cancelled' as ReadEnd;
          throw error;
        }
      },
      { isListed: () => transactionIsListed(rig.server, traceId), now: () => performance.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
      { appearMs: 5000, goneMs: TIMEOUT_MS },
    );
    seen.push(observation);
    if (observation.kind === 'gone') break;
  }
  return seen;
}

describe('a read of a node of 100,000 relationships, cancelled through the gate', () => {
  it.each(SHAPES)('leaves no transaction on the server before its timeout: $name', async ({ name, request }) => {
    const seen = await cancelling(request);
    for (const [index, observation] of seen.entries()) process.stdout.write(`${describeObservation(`${name} (attempt ${index + 1})`, observation)}\n`);
    expect(seen.some((observation) => observation.kind === 'not-gone')).toBe(false);
    for (const observation of seen) if (observation.kind === 'gone') expect(observation.goneAfterMs).toBeLessThan(TIMEOUT_MS);
  });

  it('is caught running for an expand of the node, and its transaction is gone', async () => {
    const [expand] = SHAPES;
    if (expand === undefined) throw new Error('no shape');
    const seen = await cancelling(expand.request);
    expect(seen.at(-1)?.kind).toBe('gone');
  });

  it('serves the next expand of the node after the cancels', async () => {
    const [expand] = SHAPES;
    const page = await rig.parts.gate.run(expand?.request('trace-after-cancel', new AbortController().signal) as GateRequest);
    expect(page.items).toHaveLength(1);
  });
});
