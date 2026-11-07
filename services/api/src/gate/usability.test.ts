import { describe, expect, it } from 'vitest';
import { auditing, mappingOf, nodesTemplate, sourceWith } from '../testing/gate-fixtures.js';
import { LOCAL_PRINCIPAL, TestExecutor } from '../testing/gate.js';
import { testSourceGate } from '../testing/source-gate.js';
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
const rig = (extra: Parameters<typeof testSourceGate>[1] = {}) => {
  const recording = auditing();
  const executor = new TestExecutor(() => Promise.resolve({ status: 'rows', rows: [{ id: 'p1', name: 'Neo4j Kernel', version: '5.26.0', edition: 'community', labels: [], types: [] }] }));
  return { ...testSourceGate(mapping, { catalog, seams: recording.seams, executor, ...extra }), recording, executor };
};

describe('a data read for a source whatever its checks showed', () => {
  it('is run: the gate holds no verdict of the checks, so a finding refuses only the read whose index it names, through the guard', async () => {
    const { gate, executor, recording } = rig();
    expect((await gate.run(userRequest)).items).toEqual([{ id: 'p1' }]);
    expect(executor.calls).toHaveLength(1);
    expect(recording.events).toEqual([expect.objectContaining({ action: 'test.nodes', result: 'success' })]);
  });

  it('still gives ACCESS_DENIED to a principal the policy denies, so a refusal does not tell a stranger about the source', async () => {
    const { gate, executor } = rig({ seams: { ...auditing().seams, policy: { authorizeSource: () => Promise.resolve({ allowed: false, reason: 'denied' }) } } });
    await expect(gate.run(userRequest)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(executor.calls).toEqual([]);
  });
});

describe('the checks and the pings', () => {
  it('run through the system runner', async () => {
    const { system, executor } = rig();
    expect((await system.run(systemRequest('capabilities'))).items).toHaveLength(1);
    expect((await system.run(systemRequest('schema-tokens'))).items).toHaveLength(1);
    expect(executor.calls).toHaveLength(2);
  });

  it('run for a user through the gate too: a system-scope template is not a data read', async () => {
    const { gate, executor } = rig();
    await gate.run({ ...userRequest, templateId: 'capabilities', params: {}, limit: 1 });
    expect(executor.calls).toHaveLength(1);
  });
});

describe('the audit result of a failure', () => {
  it.each([
    ['a refusal for an index that is not there', new AppError('SOURCE_UNAVAILABLE', undefined, 'index-unavailable'), 'refused'],
    ['a refusal for an index that is building', new AppError('SOURCE_UNAVAILABLE', undefined, 'index-building'), 'refused'],
    ['a refusal for an index that failed', new AppError('SOURCE_UNAVAILABLE', undefined, 'index-failed'), 'refused'],
    ['a refusal for a list of indexes that cannot be read whole', new AppError('SOURCE_UNAVAILABLE', undefined, 'index-list-unreadable'), 'refused'],
    ['a login the source refuses', new AppError('SOURCE_UNAVAILABLE', undefined, 'authentication'), 'failed'],
    ['a source that cannot be reached', new AppError('SOURCE_UNAVAILABLE', undefined, 'unreachable'), 'failed'],
    ['a source that is unavailable with no reason', new AppError('SOURCE_UNAVAILABLE'), 'failed'],
    ['a principal the policy denies', new AppError('ACCESS_DENIED'), 'denied'],
  ])('is mapped for %s', (_name, failure, result) => {
    expect(auditResultFor(failure)).toBe(result);
  });
});
