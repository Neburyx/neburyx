import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { assembleGate } from '../assemble.js';
import { createTemplateCatalog } from '../catalog.js';
import { communitySeams } from '../../seams/community-seams.js';
import { createNeo4jExecutor } from '../../sources/executor.js';
import { fakeDrivers, neo4jError } from '../../testing/fake-source-driver.js';
import { auditing, mappingOf, sourceWith } from '../../testing/gate-fixtures.js';
import { LOCAL_PRINCIPAL } from '../../testing/gate.js';
import { ENV, useClock } from '../../testing/source-rig.js';

const VALUE = 'PROPERTY-VALUE-7731';
const mapping = mappingOf(sourceWith('alpha', { auth: { kind: 'basic', username_env: 'DEMO_USER', password_env: 'DEMO_PASSWORD' } }));
const read = {
  id: 'read-one',
  version: '1',
  auditAction: 'test.read_one',
  cypher: 'MATCH (n:Item) RETURN n LIMIT 1',
  paramsSchema: z.strictObject({}),
  scope: 'user' as const,
  paged: false,
  rows: 'one' as const,
  entityParams: [],
  relationshipParams: [],
  refsOf: () => [],
  normalize: (rows: readonly Record<string, unknown>[]) => rows,
};

function rig(behaviour: Parameters<typeof fakeDrivers>[0]) {
  useClock();
  const fake = fakeDrivers(behaviour);
  const logs: object[] = [];
  const logger = { warn: (fields: object) => void logs.push(fields) };
  const executor = createNeo4jExecutor({ sources: mapping.sources, env: ENV, logger, createDriver: fake.factory });
  const recording = auditing();
  const { gate } = assembleGate({ mapping, seams: { ...communitySeams(), audit: recording.seams.audit }, executor, logger, catalog: createTemplateCatalog({ templates: [read] }) });
  return { gate, logs, events: recording.events, executor };
}

const request = { traceId: 'tr-leak', principal: LOCAL_PRINCIPAL, sourceId: 'alpha', templateId: 'read-one', params: {}, limit: 1 };

describe('a read whose rows hold a property value', () => {
  it('leaves the value in no log line and no audit event of a read that succeeds', async () => {
    const { gate, logs, events, executor } = rig({ rows: [{ n: { $type: 'node', elementId: 'e1', labels: ['Item'], properties: { secret: VALUE } } }] });
    await gate.run(request);
    expect(JSON.stringify([logs, events])).not.toContain(VALUE);
    await executor.close();
  });

  it('leaves the value in no log line, audit event or error of a read that fails with a message that holds it', async () => {
    const { gate, logs, events, executor } = rig({ beginError: neo4jError('Neo.ClientError.Statement.SyntaxError', `bad value ${VALUE}`) });
    const error: unknown = await gate.run(request).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(JSON.stringify([logs, events, String(error), (error as Error).message])).not.toContain(VALUE);
    await executor.close();
  });
});
