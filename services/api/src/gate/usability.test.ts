import { describe, expect, it } from 'vitest';
import { auditing, mappingOf, nodesTemplate, sourceWith } from '../testing/gate-fixtures.js';
import { LOCAL_PRINCIPAL, TestExecutor } from '../testing/gate.js';
import { testSourceGate } from '../testing/source-gate.js';
import { createUsabilityRecord } from '../source-test/usability.js';
import { createTemplateCatalog } from './catalog.js';
import { auditResultFor } from './audit.js';
import { AppError } from '../errors.js';
import { capabilitiesTemplate } from './templates/capabilities.js';
import { schemaTokensTemplate } from './templates/schema-tokens.js';

const mapping = mappingOf(sourceWith('alpha'));
// nodesTemplate has the scope user: the stand-in for the data templates that do not exist yet
const catalog = createTemplateCatalog({ templates: [nodesTemplate, capabilitiesTemplate, schemaTokensTemplate] });
const userRequest = { traceId: 'tr-user', principal: LOCAL_PRINCIPAL, sourceId: 'alpha', templateId: 'nodes-read', params: { kind: 'person' }, limit: 5 };
const systemRequest = (templateId: string) => ({ traceId: 'tr-system', sourceId: 'alpha', templateId, params: {}, limit: 1 });
const rig = (usable: boolean | ReturnType<typeof createUsabilityRecord>, extra: Parameters<typeof testSourceGate>[1] = {}) => {
  const recording = auditing();
  const executor = new TestExecutor(() => Promise.resolve({ status: 'rows', rows: [{ id: 'p1', name: 'Neo4j Kernel', version: '5.26.0', edition: 'community', labels: [], types: [] }] }));
  const usability = typeof usable === 'boolean' ? { isUsable: () => usable } : usable;
  return { ...testSourceGate(mapping, { catalog, usability, seams: recording.seams, executor, ...extra }), recording, executor };
};
const reached = { product: 'Neo4j Kernel', version: '5.26.32', edition: 'community' };

describe('a data read for a source that is not usable', () => {
  it('is refused with SOURCE_UNAVAILABLE and the reason unusable, audited refused, with no read made', async () => {
    const { gate, executor, recording } = rig(false);
    const failure: unknown = await gate.run(userRequest).catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(AppError);
    expect(failure).toMatchObject({ code: 'SOURCE_UNAVAILABLE', reason: 'unusable' });
    expect(executor.calls).toEqual([]);
    expect(recording.events).toEqual([expect.objectContaining({ action: 'test.nodes', result: 'refused', sourceId: 'alpha', actorId: LOCAL_PRINCIPAL.id })]);
  });

  it('is run for a source that is usable', async () => {
    const { gate, executor } = rig(true);
    expect((await gate.run(userRequest)).items).toEqual([{ id: 'p1' }]);
    expect(executor.calls).toHaveLength(1);
  });

  it('still gives ACCESS_DENIED to a principal the policy denies, whatever the state of the source, so a refusal does not tell a stranger about the source', async () => {
    const { gate } = rig(false, { seams: { ...auditing().seams, policy: { authorizeSource: () => Promise.resolve({ allowed: false, reason: 'denied' }) } } });
    await expect(gate.run(userRequest)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  });

  it('is refused for an unchecked source and run once a check that reached it passes, by the record of the running server', async () => {
    const record = createUsabilityRecord();
    const { gate } = rig(record);
    await expect(gate.run(userRequest)).rejects.toMatchObject({ reason: 'unusable' });
    record.observe({ sourceId: 'alpha', checkedAt: '2026-11-02T10:00:00.000Z', server: reached, mappingChecks: { status: 'fail', findings: [{ severity: 'fail', check: 'label', message: 'x' }] } });
    await expect(gate.run(userRequest)).rejects.toMatchObject({ reason: 'unusable' });
    record.observe({ sourceId: 'alpha', checkedAt: '2026-11-02T10:00:30.000Z', server: reached, mappingChecks: { status: 'pass', findings: [] } });
    expect((await gate.run(userRequest)).items).toHaveLength(1);
  });
});

describe('the checks and the pings on a source that is not usable', () => {
  it('run through the system runner, so an unusable source can be tested and can recover', async () => {
    const { system, executor } = rig(false);
    expect((await system.run(systemRequest('capabilities'))).items).toHaveLength(1);
    expect((await system.run(systemRequest('schema-tokens'))).items).toHaveLength(1);
    expect(executor.calls).toHaveLength(2);
  });

  it('run for a user through the gate too: a system-scope template is not a data read', async () => {
    const { gate, executor } = rig(false);
    await gate.run({ ...userRequest, templateId: 'capabilities', params: {}, limit: 1 });
    expect(executor.calls).toHaveLength(1);
  });
});

describe('the audit result of a failure', () => {
  it.each([
    ['a refusal for an unusable source', new AppError('SOURCE_UNAVAILABLE', undefined, 'unusable'), 'refused'],
    ['a source that cannot be reached', new AppError('SOURCE_UNAVAILABLE', undefined, 'unreachable'), 'failed'],
    ['a source that is unavailable with no reason', new AppError('SOURCE_UNAVAILABLE'), 'failed'],
    ['a principal the policy denies', new AppError('ACCESS_DENIED'), 'denied'],
  ])('is mapped for %s', (_name, failure, result) => {
    expect(auditResultFor(failure)).toBe(result);
  });
});
