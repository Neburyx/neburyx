import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sourceTestReportSchema } from '@neburyx/contracts';
import { AppError } from '../errors.js';
import { memoryAppStore } from '../testing/app-store.js';
import { auditing, mappingOf, sourceWith } from '../testing/gate-fixtures.js';
import { LOCAL_PRINCIPAL, TestExecutor } from '../testing/gate.js';
import { fakeSourceTester, SERVER_ROW, serverExecutor } from '../testing/source-tester.js';
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

  it('goes through the gate as the caller: the fixed capabilities Cypher then the fixed privileges Cypher, each audited with that actor and its action', async () => {
    const recording = auditing();
    const executor = serverExecutor();
    const parts = testSourceGate(mapping, { executor, seams: recording.seams });
    await createSourceTester({ gate: parts.gate, mapping, store: memoryAppStore() }).run(request());
    expect(executor.calls).toHaveLength(2);
    expect(executor.calls[0]).toMatchObject({
      cypher: "CALL dbms.components() YIELD name, versions, edition WHERE name = 'Neo4j Kernel' RETURN name, versions[0] AS version, edition",
      accessMode: 'READ',
      sourceId: 'alpha',
    });
    expect(executor.calls[1]).toMatchObject({ cypher: "SHOW USER PRIVILEGES YIELD access, action, resource, graph, segment WHERE NOT action IN ['access', 'traverse', 'read', 'match', 'execute', 'execute_function', 'load', 'show_index', 'show_constraint'] RETURN DISTINCT access, action, resource, graph, segment LIMIT $limit + 1", accessMode: 'READ', sourceId: 'alpha', rowLimit: 51 });
    expect(recording.events).toEqual([
      expect.objectContaining({ actorId: LOCAL_PRINCIPAL.id, actorRole: LOCAL_PRINCIPAL.role, action: 'source.capabilities', result: 'success', sourceId: 'alpha' }),
      expect.objectContaining({ actorId: LOCAL_PRINCIPAL.id, actorRole: LOCAL_PRINCIPAL.role, action: 'source.privileges', result: 'failed', sourceId: 'alpha' }),
    ]);
    expect(recording.events.every((event) => event.actorId !== SYSTEM_ID)).toBe(true);
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

describe('a tester given the write probe', () => {
  const READ_ONLY = { status: 'rows', rows: [] } as const;
  function probing(answer: 'can-write' | 'cannot-write' | 'inconclusive', options: { readonly capabilities?: Parameters<typeof serverExecutor>[0]; readonly privileges?: Parameters<typeof serverExecutor>[1] } = {}) {
    const calls: { readonly sourceId: string; readonly traceId: string }[] = [];
    const executor = serverExecutor(options.capabilities, options.privileges ?? READ_ONLY);
    const store = memoryAppStore();
    const parts = testSourceGate(mapping, { executor });
    const tester = createSourceTester({
      gate: parts.gate,
      mapping,
      store,
      clock: () => Date.UTC(2026, 10, 2, 10, 0, 0),
      probe: (source, traceId) => {
        calls.push({ sourceId: source.id, traceId });
        return Promise.resolve(answer);
      },
    });
    return { tester, calls, store };
  }

  it('runs the probe once, after the capabilities and the privileges, with the source and the trace ID of the run', async () => {
    const { tester, calls } = probing('cannot-write');
    await tester.run(request());
    expect(calls).toEqual([{ sourceId: 'alpha', traceId: 'tr-test' }]);
  });

  it('reports a login that can write by the probe as write-probe, warn and degraded, though the privileges showed none', async () => {
    const { tester, store } = probing('can-write');
    const report = sourceTestReportSchema.parse(await tester.run(request()));
    expect(report).toMatchObject({ outcome: 'warn', state: 'degraded', stateReason: 'The login can write to the source; give Neburyx a login that can only read.', readOnlyCheck: 'write-probe', loginCanWrite: true });
    expect(store.checks).toHaveLength(1);
    expect(store.checks[0]?.report).toEqual(report);
  });

  it('reports a login that cannot write by the probe as write-probe and pass on a Community server, which cannot list privileges', async () => {
    const { tester } = probing('cannot-write', { privileges: { status: 'unavailable', reason: 'refused' } });
    expect(await tester.run(request())).toMatchObject({ outcome: 'pass', readOnlyCheck: 'write-probe', loginCanWrite: false });
  });

  describe('on an Enterprise server', () => {
    const ENTERPRISE = { status: 'rows', rows: [{ ...SERVER_ROW, edition: 'enterprise' }] } as const;
    const WRITE_ROW = { access: 'GRANTED', action: 'set_property', resource: 'property(note)', graph: '*', segment: 'NODE(*)' };
    const SMALL_PAGES = mappingOf(sourceWith('alpha', { budgets: { max_page: 2 } }));

    function enterprise(answer: 'can-write' | 'cannot-write', privileges: Parameters<typeof serverExecutor>[1], on = mapping) {
      const parts = testSourceGate(on, { executor: serverExecutor(ENTERPRISE, privileges) });
      const store = memoryAppStore();
      return { tester: createSourceTester({ gate: parts.gate, mapping: on, store, clock: () => Date.UTC(2026, 10, 2, 10, 0, 0), probe: () => Promise.resolve(answer) }), store };
    }

    it.each([
      ['a listing longer than the page', { status: 'rows', rows: [WRITE_ROW, WRITE_ROW, WRITE_ROW] } as const, SMALL_PAGES, 'pass'],
      ['a privileges read that timed out', { status: 'timeout' } as const, mapping, 'pass'],
      ['a privileges read that the server refused', { status: 'unavailable', reason: 'refused' } as const, mapping, 'pass'],
      ['a privileges read that lost the connection', { status: 'unavailable', reason: 'unreachable' } as const, mapping, 'pass'],
      ['rows the check cannot read', { status: 'rows', rows: [{ unexpected: 'column' }] } as const, mapping, 'warn'],
    ])('keeps read-only not verified for %s, though the probe was refused', async (_name, privileges, on, outcome) => {
      const { tester, store } = enterprise('cannot-write', privileges, on);
      const report = await tester.run(request());
      expect(report).toMatchObject({ outcome, readOnlyCheck: 'not-verified', loginCanWrite: null });
      expect(store.checks[0]?.report).toEqual(report);
    });

    it('keeps the sentence about unreadable rows when the probe was refused', async () => {
      const { tester } = enterprise('cannot-write', { status: 'rows', rows: [{ unexpected: 'column' }] });
      expect(await tester.run(request())).toMatchObject({ state: 'degraded', stateReason: 'The server listed privileges that could not be read, so read-only is not verified.' });
    });

    it('lets the refusal speak when the privileges showed no write right', async () => {
      const { tester } = enterprise('cannot-write', { status: 'rows', rows: [] });
      expect(await tester.run(request())).toMatchObject({ outcome: 'pass', readOnlyCheck: 'write-probe', loginCanWrite: false });
    });

    it('lets a probe that succeeded win over privileges that could not be settled', async () => {
      const { tester } = enterprise('can-write', { status: 'unavailable', reason: 'refused' });
      expect(await tester.run(request())).toMatchObject({ outcome: 'warn', readOnlyCheck: 'write-probe', loginCanWrite: true });
    });

    it('keeps a write right that the privileges show, though the probe was refused', async () => {
      const { tester } = enterprise('cannot-write', { status: 'rows', rows: [WRITE_ROW] });
      expect(await tester.run(request())).toMatchObject({ outcome: 'warn', readOnlyCheck: 'privileges-inspected', loginCanWrite: true });
    });
  });

  it.each([
    ['a login inspected as read-only', READ_ONLY, 'privileges-inspected', false],
    ['privileges that could not be read', { status: 'unavailable', reason: 'refused' } as const, 'not-verified', null],
  ])('keeps the result of the privileges for %s when the probe is inconclusive', async (_name, privileges, check, canWrite) => {
    const { tester } = probing('inconclusive', { privileges });
    expect(await tester.run(request())).toMatchObject({ readOnlyCheck: check, loginCanWrite: canWrite });
  });

  it('does not run the probe for a server version outside the support matrix', async () => {
    const { tester, calls } = probing('can-write', { capabilities: { status: 'rows', rows: [{ ...SERVER_ROW, version: '4.4.0' }] } });
    expect(await tester.run(request())).toMatchObject({ outcome: 'warn', versionSupported: false, readOnlyCheck: 'privileges-inspected', loginCanWrite: false });
    expect(calls).toEqual([]);
  });

  it('does not run the probe for a source that did not answer', async () => {
    const { tester, calls } = probing('can-write', { capabilities: { status: 'unavailable', reason: 'unreachable' } });
    expect(await tester.run(request())).toMatchObject({ outcome: 'fail', readOnlyCheck: 'not-verified', loginCanWrite: null });
    expect(calls).toEqual([]);
  });

  it('does not run the probe for a run that is not a verdict, and stores nothing', async () => {
    const { tester, calls, store } = probing('can-write', { privileges: { status: 'unavailable', reason: 'pool-full' } });
    await expect(tester.run(request())).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    expect(calls).toEqual([]);
    expect(store.checks).toEqual([]);
  });

  it('is not what the route builds: a tester made without a probe never reports write-probe', async () => {
    const { tester } = fakeSourceTester(mapping);
    expect((await tester.run(request())).readOnlyCheck).not.toBe('write-probe');
  });

  it('keeps loginCanWrite true for the captured login whose only write right is SET PROPERTY, though the server refuses the probe to create a node', async () => {
    const captured: { readonly logins: Record<string, { readonly rows: readonly { readonly access: string; readonly action: string; readonly resource: string; readonly graph: string; readonly segment: string }[] }> } = JSON.parse(
      readFileSync(join(import.meta.dirname, 'fixtures', 'enterprise-privileges-5.26.32.json'), 'utf8'),
    );
    // the rows the template returns: everything but the read rights and the defaults of the PUBLIC role
    const listed = (captured.logins['sneaky']?.rows ?? []).filter((row) => !['access', 'traverse', 'read', 'match', 'execute', 'execute_function', 'load', 'show_index', 'show_constraint'].includes(row.action));
    expect(listed.map((row) => row.action)).toEqual(['set_property']);
    const sneaky = mappingOf(sourceWith('alpha', { database: 'nbxprivcheck' }));
    const parts = testSourceGate(sneaky, { executor: serverExecutor(undefined, { status: 'rows', rows: listed.map(({ access, action, resource, graph, segment }) => ({ access, action, resource, graph, segment })) }) });
    const store = memoryAppStore();
    const tester = createSourceTester({ gate: parts.gate, mapping: sneaky, store, probe: () => Promise.resolve('cannot-write') });
    const report = sourceTestReportSchema.parse(await tester.run(request()));
    expect(report).toMatchObject({ loginCanWrite: true, readOnlyCheck: 'privileges-inspected', outcome: 'warn', state: 'degraded', stateReason: 'The login can write to the source; give Neburyx a login that can only read.' });
    expect(store.checks[0]?.report).toEqual(report);
  });
});
