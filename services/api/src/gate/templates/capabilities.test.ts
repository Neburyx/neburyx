import { describe, expect, it } from 'vitest';
import { OPERATIONS } from '../../sources/operations.js';
import { auditing, mappingOf, sourceWith } from '../../testing/gate-fixtures.js';
import { gateRequest, LOCAL_PRINCIPAL, TestExecutor } from '../../testing/gate.js';
import { fakeSourceTester, serverExecutor } from '../../testing/source-tester.js';
import { testSourceGate } from '../../testing/source-gate.js';
import { SYSTEM_ID } from '../system-principal.js';
import { defaultCatalog } from '../assemble.js';
import { CAPABILITIES_ID, capabilitiesTemplate, isSupportedServer } from './capabilities.js';
import { CONNECTIVITY_ID } from './connectivity.js';
import { PRIVILEGES_ID } from './privileges.js';

const mapping = mappingOf(sourceWith('alpha'));
const request = { traceId: 'tr-test', principal: LOCAL_PRINCIPAL, sourceId: 'alpha' };

function answering(name: string, version: unknown, edition = 'community') {
  return serverExecutor({ status: 'rows', rows: [{ name, version, edition }] });
}

const DECLARED = Object.entries(OPERATIONS).map(([name, status]) => ({ name, status }));

describe('the default catalog', () => {
  it('holds the privileges template with scope system, no parameters, the audit action source.privileges and a paged Cypher that is fixed', () => {
    const template = defaultCatalog().find(PRIVILEGES_ID);
    expect(template).toMatchObject({ scope: 'system', paged: true, auditAction: 'source.privileges', entityParams: [], relationshipParams: [], integerParameters: [] });
    expect(template?.paramsSchema.safeParse({}).success).toBe(true);
    expect(template?.paramsSchema.safeParse({ a: 1 }).success).toBe(false);
    expect(template?.cypher).toMatch(/^SHOW USER PRIVILEGES YIELD access, action, resource, graph, segment WHERE NOT action IN \[[^\]]*\] RETURN DISTINCT access, action, resource, graph, segment LIMIT \$limit \+ 1$/);
    expect(template?.cypher).not.toContain('@');
  });

  it.each([CONNECTIVITY_ID, CAPABILITIES_ID])('holds the %s template with scope system, no parameters and no marker', (id) => {
    const template = defaultCatalog().find(id);
    expect(template).toMatchObject({ scope: 'system', paged: false, entityParams: [], relationshipParams: [] });
    expect(template?.paramsSchema.safeParse({}).success).toBe(true);
    expect(template?.paramsSchema.safeParse({ a: 1 }).success).toBe(false);
    expect(template?.cypher).not.toContain('@');
  });
});

describe('a supported server', () => {
  it.each(['5.26.0', '5.26.32', '2026.1.0', '2026.10.1', '2026.01.0'])('%s is reported pass with the adapter declaration as its operations', async (version) => {
    const { tester } = fakeSourceTester(mapping, answering('Neo4j Kernel', version));
    const report = await tester.run(request);
    expect(report).toMatchObject({ outcome: 'pass', state: 'connected', stateReason: null, versionSupported: true, server: { version } });
    expect(report.operations).toEqual(DECLARED);
  });

  it('declares no data operation as supported, because no data template exists yet', () => {
    expect(DECLARED.filter((operation) => operation.status === 'supported').map((operation) => operation.name)).toEqual(['execute']);
    expect(OPERATIONS.capabilities).toBe('by-template');
  });
});

describe('a server outside the support matrix', () => {
  it.each([
    ['5.25.9', 'Neo4j Kernel'],
    ['5.27.0', 'Neo4j Kernel'],
    ['5.260.1', 'Neo4j Kernel'],
    ['2025.12.0', 'Neo4j Kernel'],
    ['4.4.0', 'Neo4j Kernel'],
    ['2026', 'Neo4j Kernel'],
    ['', 'Neo4j Kernel'],
  ])('%j from %s is reported warn with no operations', async (version, product) => {
    const { tester } = fakeSourceTester(mapping, answering(product, version));
    const report = await tester.run(request);
    expect(report).toMatchObject({
      outcome: 'warn',
      state: 'degraded',
      stateReason: 'The server version is not on the support matrix.',
      versionSupported: false,
      operations: [],
      server: { product, version },
    });
  });

  it('is decided by one function of the product and the version', () => {
    expect(isSupportedServer('Neo4j Kernel', '5.26.1')).toBe(true);
    expect(isSupportedServer('Neo4j Kernel', '5.26')).toBe(false);
    expect(isSupportedServer('Another Server', '5.26.0')).toBe(false);
  });
});

describe('rows that do not match the template', () => {
  it.each([
    ['no row', []],
    ['two rows', [{ name: 'Neo4j Kernel', version: '5.26.0', edition: 'community' }, { name: 'Neo4j Kernel', version: '5.26.0', edition: 'community' }]],
    ['a row with no edition', [{ name: 'Neo4j Kernel', version: '5.26.0' }]],
    ['a version that is not text', [{ name: 'Neo4j Kernel', version: 5.26, edition: 'community' }]],
    ['an empty product', [{ name: '', version: '5.26.0', edition: 'community' }]],
  ])('%s gives INTERNAL_ERROR and no report', async (_name, rows) => {
    const executor = serverExecutor({ status: 'rows', rows });
    const { tester } = fakeSourceTester(mapping, executor);
    await expect(tester.run(request)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });
});

describe('a run through the system runner', () => {
  it('returns the same item as a user run and is audited with the fixed system id and no role', async () => {
    const recording = auditing();
    const executor = answering('Neo4j Kernel', '5.26.32');
    const { gate, system } = testSourceGate(mapping, { executor, seams: recording.seams });
    const asUser = await gate.run(gateRequest({ sourceId: 'alpha', templateId: CAPABILITIES_ID, params: {}, limit: 1 }));
    const asSystem = await system.run({ traceId: 'tr-system', sourceId: 'alpha', templateId: CAPABILITIES_ID, params: {}, limit: 1 });
    expect(asSystem.items).toEqual(asUser.items);
    expect(recording.events.map((event) => [event.actorId, event.actorRole, event.action])).toEqual([
      [LOCAL_PRINCIPAL.id, LOCAL_PRINCIPAL.role, 'source.capabilities'],
      [SYSTEM_ID, null, 'source.capabilities'],
    ]);
  });
});

describe('the template', () => {
  it('has the audit action the audit events name', () => {
    expect(capabilitiesTemplate.auditAction).toBe('source.capabilities');
  });
});
