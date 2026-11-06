import { describe, expect, it } from 'vitest';
import { ALWAYS_USABLE } from '../testing/usability.js';
import { AppError } from '../errors.js';
import type { Principal } from '../seams/seams.js';
import { auditing, mappingOf, nodesTemplate, sourceWith } from '../testing/gate-fixtures.js';
import { gateRequest, LOCAL_PRINCIPAL, recordingObserver, TestExecutor } from '../testing/gate.js';
import { testSourceGate } from '../testing/source-gate.js';
import { createTemplateCatalog } from './catalog.js';
import { createSourceGate } from './source-gate.js';
import { SYSTEM_ID, SYSTEM_PRINCIPAL } from './system-principal.js';
import { capabilitiesTemplate } from './templates/capabilities.js';
import { connectivityTemplate } from './templates/connectivity.js';

const mapping = mappingOf(sourceWith('alpha'));
const catalog = createTemplateCatalog({ templates: [connectivityTemplate, capabilitiesTemplate, nodesTemplate] });
const COMPONENT = { name: 'Neo4j Kernel', version: '5.26.0', edition: 'community' };
const withComponent = () => new TestExecutor(() => Promise.resolve({ status: 'rows', rows: [COMPONENT] }));
const systemRequest = (templateId: string, params: unknown = {}) => ({ traceId: 'tr-system', sourceId: 'alpha', templateId, params, limit: 1 });

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof AppError ? error.code : 'not an AppError';
  }
  return 'no error';
}

describe('the system runner', () => {
  it('runs a system template and audits the fixed system id with a null role', async () => {
    const recording = auditing();
    const { system, executor } = testSourceGate(mapping, { catalog, seams: recording.seams, executor: withComponent() });
    const page = await system.run(systemRequest('capabilities'));
    expect(page.items).toMatchObject([{ product: 'Neo4j Kernel', version: '5.26.0', edition: 'community', versionSupported: true }]);
    expect(executor.calls).toHaveLength(1);
    expect(recording.events).toEqual([{ actorId: SYSTEM_ID, actorRole: null, action: 'source.capabilities', result: 'success', sourceId: 'alpha', traceId: 'tr-system' }]);
  });

  it('refuses a template whose scope is user with ACCESS_DENIED from the authorize stage, after validate, audited denied, with the executor not called', async () => {
    const recording = auditing();
    const observer = recordingObserver();
    const { system, executor } = testSourceGate(mapping, { catalog, seams: recording.seams, observer });
    expect(await codeOf(system.run(systemRequest('nodes-read', { kind: 'person' })))).toBe('ACCESS_DENIED');
    expect(executor.calls).toEqual([]);
    expect(recording.events.map((event) => event.result)).toEqual(['denied']);
    expect(observer.events.filter((event) => event.outcome === 'ok').map((event) => event.stage)).toEqual(['resolve', 'validate', 'audit']);
    expect(observer.events.filter((event) => event.outcome === 'failed').map((event) => event.stage)).toEqual(['authorize']);
  });

  it('still validates the request first: an unknown template or a bad parameter is INVALID_REQUEST', async () => {
    const { system } = testSourceGate(mapping, { catalog });
    expect(await codeOf(system.run(systemRequest('absent')))).toBe('INVALID_REQUEST');
    expect(await codeOf(system.run(systemRequest('connectivity', { a: 1 })))).toBe('INVALID_REQUEST');
  });

  it('does not ask the policy provider, while a user request does', async () => {
    const recording = auditing();
    const { gate, system } = testSourceGate(mapping, { catalog, seams: recording.seams, executor: withComponent() });
    await system.run(systemRequest('connectivity'));
    expect(recording.asked).toEqual([]);
    await gate.run(gateRequest({ sourceId: 'alpha', templateId: 'connectivity', params: {}, limit: 1 }));
    expect(recording.asked).toEqual([1]);
  });

  it('ignores a principal that rides along on the request: the audit event, and the coordinator, see only the system principal', async () => {
    const recording = auditing();
    const seen: Principal[] = [];
    const coordinator = { acquireRead: (request: { principal: Principal }) => (seen.push(request.principal), Promise.resolve({ status: 'granted' as const, lease: { release: () => Promise.resolve() } })) };
    const { system } = testSourceGate(mapping, { catalog, seams: { ...recording.seams, coordinator }, executor: withComponent() });
    await system.run(Object.assign(systemRequest('capabilities'), { principal: LOCAL_PRINCIPAL }));
    expect(recording.events[0]?.actorId).toBe(SYSTEM_ID);
    expect(seen).toEqual([SYSTEM_PRINCIPAL]);
  });
});

describe('a user running a system template', () => {
  it('runs as that user and is audited as that user', async () => {
    const recording = auditing();
    const { gate } = testSourceGate(mapping, { catalog, seams: recording.seams, executor: withComponent() });
    await gate.run(gateRequest({ sourceId: 'alpha', templateId: 'connectivity', params: {}, limit: 1 }));
    expect(recording.events[0]).toMatchObject({ actorId: LOCAL_PRINCIPAL.id, actorRole: LOCAL_PRINCIPAL.role });
  });
});

describe('createSourceGate', () => {
  it('returns a Gate that has no member that runs as the system principal, a separate system runner, and a close', async () => {
    const parts = createSourceGate({ usability: ALWAYS_USABLE, mapping, env: {}, seams: auditing().seams, logger: { warn: () => undefined } });
    expect(Object.keys(parts).sort()).toEqual(['close', 'gate', 'indexes', 'system']);
    expect(Object.keys(parts.indexes)).toEqual(['read']);
    expect(Object.keys(parts.gate)).toEqual(['run']);
    expect(Object.keys(parts.system)).toEqual(['run']);
    await parts.close();
  });
});
