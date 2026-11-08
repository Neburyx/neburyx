import { performance } from 'node:perf_hooks';
import { RequestCancelled } from '../../errors.js';
import { EXPAND_NEIGHBORS_ID } from '../../gate/templates/expand-neighbors.js';
import { gateRequest, LOCAL_PRINCIPAL } from '../gate.js';
import { transactionIsListed } from '../neo4j-server.js';
import { describeObservation, LIST_INTERVAL_MS, observeCancel, type ReadEnd } from './cancel.js';
import { hubOf } from './fixture.js';
import { SIZES } from './plan.js';
import type { CancelCell, CancelRecord } from './record.js';
import type { Rig } from './rig.js';
import { summarize } from './stats.js';

/** Aborted reads per size, and unaborted runs of the same read. */
const ATTEMPTS = 20;
const UNCANCELLED_RUNS = 5;
/** The source's default transaction timeout, which a transaction that stays listed is waited for. */
const TIMEOUT_MS = 5000;

let sequence = 0;

const requestFor = (size: number, traceId: string, signal?: AbortSignal) =>
  gateRequest({ traceId, sourceId: 'graph', principal: LOCAL_PRINCIPAL, templateId: EXPAND_NEIGHBORS_ID, params: { entityType: 'hub', stableId: hubOf(size), neighborType: 'leaf', direction: 'both', sort: 'observed' }, limit: 25, ...(signal === undefined ? {} : { signal }) });

/** Aborts a running expand of each anchor once the server lists its transaction, and records how long it stays listed, with the time the same read takes when it is not aborted. */
export async function measureCancel(rig: Rig): Promise<CancelRecord> {
  const { server, parts } = rig;
  const cells: CancelCell[] = [];
  for (const size of SIZES) {
    const uncancelled: number[] = [];
    for (let run = 0; run < UNCANCELLED_RUNS; run += 1) {
      const started = performance.now();
      await parts.gate.run(requestFor(size, `trace-plain-${++sequence}`));
      uncancelled.push(performance.now() - started);
    }
    const gone: number[] = [];
    let finishedFirst = 0;
    let notGone = 0;
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      let traceId = '';
      const observation = await observeCancel(
        async (signal) => {
          traceId = `trace-cancel-${++sequence}-${Date.now()}`;
          try {
            await parts.gate.run(requestFor(size, traceId, signal));
            return 'other' as ReadEnd;
          } catch (error) {
            if (error instanceof RequestCancelled) return 'cancelled' as ReadEnd;
            throw error;
          }
        },
        { isListed: () => transactionIsListed(server, traceId), now: () => performance.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
        { appearMs: 10_000, goneMs: TIMEOUT_MS },
      );
      process.stdout.write(`${describeObservation(`${size} relationships, attempt ${attempt + 1}`, observation)}\n`);
      if (observation.kind === 'gone') gone.push(observation.goneAfterMs);
      else if (observation.kind === 'finished-first') finishedFirst += 1;
      else notGone += 1;
    }
    cells.push({ size, attempts: ATTEMPTS, gone: gone.length === 0 ? undefined : summarize(gone), finishedFirst, notGone, uncancelled: summarize(uncancelled) });
  }
  return { intervalMs: LIST_INTERVAL_MS, timeoutMs: TIMEOUT_MS, cells };
}
