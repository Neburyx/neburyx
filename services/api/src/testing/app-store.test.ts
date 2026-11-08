import { describe, expect, it } from 'vitest';
import { reportFromFailure, reportFromServer } from '../source-test/report.js';
import { NOT_CHECKED_SINCE_START } from '../source-test/reasons.js';
import { identityHashOf } from '../registry/identity-hash.js';
import { memoryAppStore } from './app-store.js';
import { mappingOf, sourceWith } from './gate-fixtures.js';

const mapping = mappingOf(sourceWith('alpha'));
const [alpha] = mapping.sources;
if (alpha === undefined) throw new Error('the fixture mapping has a source');
const SERVER = { product: 'Neo4j Kernel', version: '5.26.32', edition: 'community', versionSupported: true, operations: [] };
const at = (minute: number): string => new Date(Date.UTC(2026, 10, 2, 10, minute, 0)).toISOString();
const hashes = { identityHash: identityHashOf(alpha), configHash: alpha.configHash };
const ping = (store: ReturnType<typeof memoryAppStore>, reachable: boolean) =>
  store.applyPingState({ sourceId: 'alpha', reachable, reason: reachable ? null : 'The source could not be reached.', observedAt: at(59), ...hashes });
const stateOf = async (store: ReturnType<typeof memoryAppStore>) => (await store.listSources()).map((row) => [row.state, row.stateReason]);

async function opened() {
  const store = memoryAppStore();
  await store.syncSources(mapping.sources);
  return store;
}

describe('the in-memory store follows the shared source state rule', () => {
  it('restores the state of the newest check that reached the source on a reachable ping, whatever stored it', async () => {
    const store = await opened();
    await store.recordSourceCheck({ id: '01', report: reportFromServer(alpha, SERVER, null, at(1)), triggeredBy: null, ...hashes });
    await store.recordSourceCheck({ id: '02', report: reportFromFailure(alpha, 'unreachable', at(2)), triggeredBy: null, ...hashes });
    await ping(store, true);
    expect(await stateOf(store)).toEqual([['connected', null]]);
  });

  it('ignores a check of another mapping, and says not checked when none qualifies', async () => {
    const store = await opened();
    await store.recordSourceCheck({ id: '01', report: reportFromServer(alpha, SERVER, null, at(1)), triggeredBy: null, identityHash: hashes.identityHash, configHash: 'another-mapping' });
    await ping(store, true);
    expect(await stateOf(store)).toEqual([['unknown', NOT_CHECKED_SINCE_START]]);
  });

  it('writes the sentence on an unreachable ping', async () => {
    const store = await opened();
    await ping(store, false);
    expect(await stateOf(store)).toEqual([['unavailable', 'The source could not be reached.']]);
  });

  it('marks a source not checked only when no check qualifies', async () => {
    const store = await opened();
    await store.recordSourceCheck({ id: '01', report: reportFromServer(alpha, SERVER, null, at(1)), triggeredBy: null, ...hashes });
    await store.markSourceUnchecked('alpha', NOT_CHECKED_SINCE_START, hashes);
    expect(await stateOf(store)).toEqual([['connected', null]]);
    await store.markSourceUnchecked('alpha', NOT_CHECKED_SINCE_START, { ...hashes, configHash: 'another-mapping' });
    expect(await stateOf(store)).toEqual([['unknown', NOT_CHECKED_SINCE_START]]);
  });
});
