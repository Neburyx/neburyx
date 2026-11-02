import { describe, expect, it } from 'vitest';
import { sourceTestReportSchema } from '@neburyx/contracts';
import { AppError } from '../errors.js';
import { memoryAppStore } from '../testing/app-store.js';
import { auditing, mappingOf, sourceWith } from '../testing/gate-fixtures.js';
import { LOCAL_PRINCIPAL, TestExecutor } from '../testing/gate.js';
import { fakeSourceTester, SERVER_ROW } from '../testing/source-tester.js';
import { SYSTEM_ID } from '../gate/system-principal.js';
import { createSourceTester } from './tester.js';
import { testSourceGate } from '../testing/source-gate.js';

const mapping = mappingOf(sourceWith('alpha'));
const request = (sourceId = 'alpha') => ({ traceId: 'tr-test', principal: LOCAL_PRINCIPAL, sourceId });

describe('a run for a source that answers', () => {
  it('reports pass with the server facts, the mapping summary and read-only not verified', async () => {
    const { tester } = fakeSourceTester(mapping);
    const report = await tester.run(request());
    expect(sourceTestReportSchema.parse(report)).toMatchObject({
      schemaVersion: 1,
      sourceId: 'alpha',
      checkedAt: '2026-11-02T10:00:00.000Z',
      outcome: 'pass',
      state: 'connected',
      stateReason: null,
      server: { product: 'Neo4j Kernel', version: '5.26.32', edition: 'community' },
      versionSupported: true,
      readOnlyCheck: 'not-verified',
      mappingSummary: { entityTypes: 2, relationshipTypes: 2, derivedRules: 0 },
    });
  });

  it('goes through the gate as the caller: one read with the fixed capabilities Cypher, audited with that actor and action', async () => {
    const recording = auditing();
    const executor = new TestExecutor(() => Promise.resolve({ status: 'rows', rows: [SERVER_ROW] }));
    const parts = testSourceGate(mapping, { executor, seams: recording.seams });
    await createSourceTester({ gate: parts.gate, mapping, store: memoryAppStore() }).run(request());
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]).toMatchObject({
      cypher: "CALL dbms.components() YIELD name, versions, edition WHERE name = 'Neo4j Kernel' RETURN name, versions[0] AS version, edition",
      accessMode: 'READ',
      sourceId: 'alpha',
    });
    expect(recording.events).toEqual([
      expect.objectContaining({ actorId: LOCAL_PRINCIPAL.id, actorRole: LOCAL_PRINCIPAL.role, action: 'source.capabilities', result: 'success', sourceId: 'alpha' }),
    ]);
    expect(recording.events[0]?.actorId).not.toBe(SYSTEM_ID);
  });
});

describe('a run for a source the mapping does not hold', () => {
  it('answers NOT_FOUND and never calls the executor', async () => {
    const { tester, executor } = fakeSourceTester(mapping);
    await expect(tester.run(request('absent'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(executor.calls).toEqual([]);
  });
});

describe('the tester', () => {
  it('has a run member only, so nothing that holds it can reach the system runner', () => {
    expect(Object.keys(fakeSourceTester(mapping).tester)).toEqual(['run']);
  });

  it('rethrows what the gate throws', async () => {
    const executor = new TestExecutor(() => Promise.resolve({ status: 'unavailable', reason: 'pool-full' }));
    const { tester } = fakeSourceTester(mapping, executor);
    const failure: unknown = await tester.run(request()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AppError);
    expect(failure).toMatchObject({ code: 'SOURCE_UNAVAILABLE', reason: 'pool-full' });
  });
});
