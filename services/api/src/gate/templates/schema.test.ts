import { describe, expect, it } from 'vitest';
import { baseSource, firstSource, load } from '../../testing/mapping.js';
import { LOCAL_PRINCIPAL, TestExecutor } from '../../testing/gate.js';
import { testSourceGate } from '../../testing/source-gate.js';
import { defaultCatalog } from '../assemble.js';
import { SCHEMA_INDEXES_ID } from './schema-indexes.js';
import { SCHEMA_TOKENS_ID } from './schema-tokens.js';
import { STABLE_ID_DUPLICATES_ID } from './stable-id-duplicates.js';

const mapping = load(
  baseSource({
    id: 'alpha',
    entities: [
      { type: 'gadget', label: 'Gadget', stable_id: 'gadgetId', search: ['title'], reference: ['extRef'] },
      { type: 'person', label: 'Person', stable_id: 'personId' },
    ],
    relationships: [{ type: 'MADE_BY', from: 'gadget', to: 'person', stable_id: 'linkId', observed_at: 'madeAt', evidence: ['recordId'] }],
  }),
);
const source = firstSource(mapping);

describe('the schema templates in the default catalog', () => {
  it.each([
    [SCHEMA_TOKENS_ID, ['mappedLabels', 'mappedTypes'], 'source.schema_tokens'],
    [SCHEMA_INDEXES_ID, ['mappedLabels', 'mappedTypes', 'mappedProperties'], 'source.schema_indexes'],
  ])('hold %s with scope system, no parameter a caller can give, the gate-filled parameters and one row', (id, gateParameters, auditAction) => {
    const template = defaultCatalog().find(id);
    expect(template).toMatchObject({ scope: 'system', paged: false, entityParams: [], relationshipParams: [], gateParameters, auditAction });
    expect(template?.paramsSchema.safeParse({}).success).toBe(true);
    expect(template?.paramsSchema.safeParse({ mappedLabels: ['X'] }).success).toBe(false);
    expect(template?.paramsSchema.safeParse({ anything: 1 }).success).toBe(false);
  });

  it('hold stable-id-duplicates with scope system, one entity type parameter, the label and the property as markers and the index hint', () => {
    const template = defaultCatalog().find(STABLE_ID_DUPLICATES_ID);
    expect(template).toMatchObject({ scope: 'system', paged: false, entityParams: ['entityType'], relationshipParams: [], auditAction: 'source.stable_id_duplicates' });
    expect(template?.paramsSchema.safeParse({ entityType: 'gadget' }).success).toBe(true);
    expect(template?.paramsSchema.safeParse({ entityType: 'gadget', property: 'x' }).success).toBe(false);
    expect(template?.paramsSchema.safeParse({}).success).toBe(false);
    expect(template?.cypher).toContain('USING INDEX n:@entity(entityType)(@stableId(entityType))');
  });
});

describe('a request for a schema template through the gate', () => {
  const request = (templateId: string, params: unknown = {}) => ({ traceId: 'tr-test', principal: LOCAL_PRINCIPAL, sourceId: 'alpha', templateId, params, limit: 1 });
  const rig = () => {
    const executor = new TestExecutor(() => Promise.resolve({ status: 'rows', rows: [] }));
    return { ...testSourceGate(mapping, { executor }), executor };
  };

  it('sends the fixed Cypher of the tokens read with the mapped labels and types, sorted, and the limit', async () => {
    const { gate, executor } = rig();
    await gate.run(request(SCHEMA_TOKENS_ID)).catch(() => undefined);
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]).toMatchObject({ templateId: SCHEMA_TOKENS_ID, accessMode: 'READ', rowLimit: 2, parameters: { mappedLabels: ['Gadget', 'Person'], mappedTypes: ['MADE_BY'], limit: 1 } });
    expect(executor.calls[0]?.cypher).toContain('CALL { CALL db.labels() YIELD label RETURN collect(label) AS labels }');
  });

  it('sends the mapped properties of every entity and relationship type to the indexes read', async () => {
    const { gate, executor } = rig();
    await gate.run(request(SCHEMA_INDEXES_ID)).catch(() => undefined);
    expect(executor.calls[0]?.parameters['mappedProperties']).toEqual(['extRef', 'gadgetId', 'linkId', 'madeAt', 'personId', 'recordId', 'title']);
  });

  it('writes the label and the stable id of the entity type into the duplicates read, and no parameter for the property', async () => {
    const { gate, executor } = rig();
    await gate.run(request(STABLE_ID_DUPLICATES_ID, { entityType: 'gadget' })).catch(() => undefined);
    expect(executor.calls[0]?.cypher).toBe(
      'MATCH (n:`Gadget`) USING INDEX n:`Gadget`(`gadgetId`) WHERE n.`gadgetId` IS NOT NULL WITH n.`gadgetId` AS value, count(*) AS c WHERE c > 1 RETURN toFloat(count(value)) AS duplicated',
    );
    expect(Object.keys(executor.calls[0]?.parameters ?? {})).toEqual(['limit']);
  });

  it.each([
    ['a parameter on the tokens read', SCHEMA_TOKENS_ID, { mappedLabels: ['Injected'] }],
    ['a parameter on the indexes read', SCHEMA_INDEXES_ID, { mappedProperties: ['secret'] }],
    ['an entity type that is not mapped', STABLE_ID_DUPLICATES_ID, { entityType: 'absent' }],
    ['a property on the duplicates read', STABLE_ID_DUPLICATES_ID, { entityType: 'gadget', property: 'secret' }],
    ['no entity type on the duplicates read', STABLE_ID_DUPLICATES_ID, {}],
  ])('refuses %s as INVALID_REQUEST and makes no read', async (_name, templateId, params) => {
    const { gate, executor } = rig();
    await expect(gate.run(request(templateId, params))).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(executor.calls).toEqual([]);
  });

  it('does not let a source with an entity type of its own name reach another source', async () => {
    const { gate } = rig();
    await expect(gate.run({ ...request(SCHEMA_TOKENS_ID), sourceId: 'beta' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(source.id).toBe('alpha');
  });
});

describe('the answers of the schema templates', () => {
  const rigWith = (rows: readonly Record<string, unknown>[]) => testSourceGate(mapping, { executor: new TestExecutor(() => Promise.resolve({ status: 'rows', rows })) });
  const ask = (parts: ReturnType<typeof rigWith>, templateId: string, params: unknown = {}) => parts.gate.run({ traceId: 'tr-test', principal: LOCAL_PRINCIPAL, sourceId: 'alpha', templateId, params, limit: 1 });

  it('are items for rows of the expected shape', async () => {
    expect((await ask(rigWith([{ labels: ['Gadget'], types: [] }]), SCHEMA_TOKENS_ID)).items).toEqual([{ labels: ['Gadget'], types: [] }]);
    expect((await ask(rigWith([{ duplicated: 2 }]), STABLE_ID_DUPLICATES_ID, { entityType: 'gadget' })).items).toEqual([{ duplicated: 2 }]);
    const index = { type: 'RANGE', entityType: 'NODE', name: 'Gadget', property: 'title', single: true, state: 'ONLINE', constrained: false };
    expect((await ask(rigWith([{ indexes: [index], truncated: false }]), SCHEMA_INDEXES_ID)).items).toEqual([{ indexes: [index], truncated: false }]);
  });

  it.each([
    ['tokens of the wrong type', SCHEMA_TOKENS_ID, [{ labels: 'Gadget', types: [] }], { labels: 'string', types: 'object' }],
    ['an index of another type', SCHEMA_INDEXES_ID, [{ indexes: [{ type: 'FULLTEXT' }], truncated: false }], { indexes: 'object', truncated: 'boolean' }],
    ['a count that is not a whole number', STABLE_ID_DUPLICATES_ID, [{ duplicated: 1.5 }], { duplicated: 'number' }],
    ['a count that is negative', STABLE_ID_DUPLICATES_ID, [{ duplicated: -1 }], { duplicated: 'number' }],
  ])('are an unreadable item with the type of each column and no value for %s', async (_name, templateId, rows, shape) => {
    const params = templateId === STABLE_ID_DUPLICATES_ID ? { entityType: 'gadget' } : {};
    expect((await ask(rigWith(rows), templateId, params)).items).toEqual([{ unreadable: shape }]);
  });

  it.each([SCHEMA_TOKENS_ID, SCHEMA_INDEXES_ID])('are an unreadable item for %s when the server returns no row', async (templateId) => {
    expect((await ask(rigWith([]), templateId)).items).toEqual([{ unreadable: { rows: '0' } }]);
  });
});
