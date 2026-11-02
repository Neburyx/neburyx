import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { memoryStoreWith } from '../testing/app-store.js';
import { auditing, mappingOf, sourceWith } from '../testing/gate-fixtures.js';
import { gateRequest, LOCAL_PRINCIPAL, recordingObserver, TestExecutor } from '../testing/gate.js';
import { testSourceGate } from '../testing/source-gate.js';
import type { Principal } from '../seams/seams.js';
import { SYSTEM_ID, SYSTEM_PRINCIPAL } from './system-principal.js';

const mapping = mappingOf(sourceWith('alpha'));
const COMPONENT = { name: 'Neo4j Kernel', version: '5.26.0', edition: 'community' };

const bodyJson = (id: string): Principal => JSON.parse(`{"id":"${id}","displayName":"System","role":null}`);
const tokenClaims = (id: string): Principal => {
  const claims: Record<string, unknown> = JSON.parse(`{"sub":"${id}","name":"System"}`);
  return { id: String(claims['sub']), displayName: String(claims['name']), role: null };
};

async function identityStoreResult(id: string): Promise<Principal> {
  const store = memoryStoreWith({});
  const real = await store.current();
  return { ...real.principal, id };
}

const SOURCES: readonly (readonly [string, (id: string) => Promise<Principal> | Principal])[] = [
  ['a request body', bodyJson],
  ['a token claim', tokenClaims],
  ['parsed JSON', (id) => JSON.parse(JSON.stringify({ id, displayName: 'System', role: null }))],
  ['the identity store result', identityStoreResult],
  ['a copy of the fields', (id) => ({ ...SYSTEM_PRINCIPAL, id })],
];

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof AppError ? error.code : 'not an AppError';
  }
  return 'no error';
}

describe.each(SOURCES)('a principal from %s that carries the system id', (_name, make) => {
  it('is refused by gate.run with ACCESS_DENIED from the authorize stage, audited denied, with the policy provider not asked and the executor not called', async () => {
    const recording = auditing();
    const observer = recordingObserver();
    const { gate, executor } = testSourceGate(mapping, { seams: recording.seams, observer });
    const principal = await make(SYSTEM_ID);
    expect(await codeOf(gate.run(gateRequest({ sourceId: 'alpha', templateId: 'connectivity', params: {}, limit: 1, principal })))).toBe('ACCESS_DENIED');
    expect(recording.events.map((event) => event.result)).toEqual(['denied']);
    expect(recording.asked).toEqual([]);
    expect(executor.calls).toEqual([]);
    expect(observer.events.filter((event) => event.outcome === 'failed').map((event) => event.stage)).toEqual(['authorize']);
  });

  it('runs as that user, audited with its own id, when the id is any other', async () => {
    const recording = auditing();
    const executor = new TestExecutor(() => Promise.resolve({ status: 'rows', rows: [COMPONENT] }));
    const { gate } = testSourceGate(mapping, { seams: recording.seams, executor });
    const principal = await make(LOCAL_PRINCIPAL.id);
    await gate.run(gateRequest({ sourceId: 'alpha', templateId: 'connectivity', params: {}, limit: 1, principal }));
    expect(recording.events[0]?.actorId).toBe(LOCAL_PRINCIPAL.id);
    expect(recording.asked).toEqual([1]);
    expect(executor.calls).toHaveLength(1);
  });
});

const SPELLINGS: readonly (readonly [string, string])[] = [
  ['upper case', SYSTEM_ID.toUpperCase()],
  ['no hyphens', SYSTEM_ID.replaceAll('-', '')],
  ['in braces', `{${SYSTEM_ID}}`],
  ['with the hyphens elsewhere', '0000-0000-0000-4000-8000-0000-0000-0000'],
  ['in braces without hyphens', `{${SYSTEM_ID.replaceAll('-', '')}}`],
];

describe.each(SPELLINGS)('the system id spelled %s', (_name, id) => {
  it('is refused by gate.run with ACCESS_DENIED, audited denied, with the policy provider not asked', async () => {
    const recording = auditing();
    const { gate, executor } = testSourceGate(mapping, { seams: recording.seams });
    const principal: Principal = { id, displayName: 'System', role: null };
    expect(await codeOf(gate.run(gateRequest({ sourceId: 'alpha', templateId: 'connectivity', params: {}, limit: 1, principal })))).toBe('ACCESS_DENIED');
    expect(recording.events.map((event) => event.result)).toEqual(['denied']);
    expect(recording.asked).toEqual([]);
    expect(executor.calls).toEqual([]);
  });
});

describe('the system principal object itself', () => {
  it('is refused by gate.run like any principal that carries the system id', async () => {
    const recording = auditing();
    const { gate, executor } = testSourceGate(mapping, { seams: recording.seams });
    expect(await codeOf(gate.run(gateRequest({ sourceId: 'alpha', templateId: 'connectivity', params: {}, limit: 1, principal: SYSTEM_PRINCIPAL })))).toBe('ACCESS_DENIED');
    expect(recording.events.map((event) => event.result)).toEqual(['denied']);
    expect(executor.calls).toEqual([]);
  });
});
