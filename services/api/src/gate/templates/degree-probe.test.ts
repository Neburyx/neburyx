import { describe, expect, it } from 'vitest';
import { CHEAP_PLAN } from '../../testing/fitting-schema.js';
import { LOCAL_PRINCIPAL, TestExecutor } from '../../testing/gate.js';
import { baseSource, firstSource, load } from '../../testing/mapping.js';
import { testSourceGate } from '../../testing/source-gate.js';
import { defaultCatalog } from '../assemble.js';
import type { ExecuteOutcome } from '../executor.js';
import { DEGREE_PROBE_ID } from './degree-probe.js';

const mapping = load(
  baseSource({
    id: 'alpha',
    entities: [
      { type: 'gadget', label: 'Gadget', stable_id: 'gadgetId' },
      { type: 'person', label: 'Order Person', stable_id: 'personId' },
    ],
    relationships: [{ type: 'MADE BY', from: 'gadget', to: 'person' }],
  }),
);
firstSource(mapping);

const request = (params: unknown) => ({ traceId: 'tr-test', principal: LOCAL_PRINCIPAL, sourceId: 'alpha', templateId: DEGREE_PROBE_ID, params, limit: 1 });
const rig = (answer: ExecuteOutcome = { status: 'rows', rows: [{ outgoing: 7, incoming: 3 }], plan: CHEAP_PLAN }) => {
  const executor = new TestExecutor(() => Promise.resolve(answer));
  return { ...testSourceGate(mapping, { executor }), executor };
};
const probe = { entityType: 'person', relationshipType: 'MADE BY' };

describe('the degree-probe template in the default catalog', () => {
  it('is a profiled system template with the entity type and one relationship type as its only parameters, and no value, filter or page', () => {
    const template = defaultCatalog().find(DEGREE_PROBE_ID);
    expect(template).toMatchObject({ scope: 'system', paged: false, profile: true, entityParams: ['entityType'], relationshipParams: ['relationshipType'], auditAction: 'source.degree_probe' });
    expect(template?.cypher.startsWith('PROFILE MATCH (n:@entity(entityType)) WITH n LIMIT 1 RETURN COUNT { (n)-[:@relationship(relationshipType)]->() } AS outgoing')).toBe(true);
    expect(template?.cypher).not.toMatch(/WHERE|\$/);
    expect(template?.gateParameters).toBeUndefined();
    expect(template?.paramsSchema.safeParse(probe).success).toBe(true);
    expect(template?.paramsSchema.safeParse({ entityType: 'person', relationshipType: ['MADE BY'] }).success).toBe(false);
    expect(template?.paramsSchema.safeParse({ ...probe, extra: 1 }).success).toBe(false);
    expect(template?.paramsSchema.safeParse({ entityType: 'person' }).success).toBe(false);
  });
});

describe('a degree probe through the gate', () => {
  it('sends the fixed Cypher with the label and the relationship type written in as quoted names, in a profiled read with the limit', async () => {
    const { gate, executor } = rig();
    await gate.run(request(probe));
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]).toMatchObject({
      templateId: DEGREE_PROBE_ID,
      accessMode: 'READ',
      profile: true,
      rowLimit: 2,
      cypher:
        'PROFILE MATCH (n:`Order Person`) WITH n LIMIT 1 RETURN COUNT { (n)-[:`MADE BY`]->() } AS outgoing, COUNT { (n)<-[:`MADE BY`]-() } AS incoming',
      parameters: { limit: 1 },
    });
  });

  it('answers the operators of the plan and none of the two counts the anchor node gave', async () => {
    const { gate } = rig();
    const page = await gate.run(request(probe));
    expect(page).toEqual({ items: [{ operators: CHEAP_PLAN }], hasMore: false });
    expect(JSON.stringify(page)).not.toMatch(/"(outgoing|incoming)":\s*\d/);
  });

  it('still answers the operators when the label has no node and the statement gives no row', async () => {
    const { gate } = rig({ status: 'rows', rows: [], plan: CHEAP_PLAN });
    expect(await gate.run(request(probe))).toEqual({ items: [{ operators: CHEAP_PLAN }], hasMore: false });
  });

  it('says there is no plan when the executor gave none', async () => {
    const { gate } = rig({ status: 'rows', rows: [{ outgoing: 0, incoming: 0 }], plan: null });
    expect(await gate.run(request(probe))).toEqual({ items: [{ operators: null }], hasMore: false });
    const absent = rig({ status: 'rows', rows: [] });
    expect(await absent.gate.run(request(probe))).toEqual({ items: [{ operators: null }], hasMore: false });
  });

  it('answers an unreadable marker with the row count and no value when the statement gave more than one row', async () => {
    const { gate } = rig({ status: 'rows', rows: [{ outgoing: 1, incoming: 1 }, { outgoing: 2, incoming: 2 }], plan: CHEAP_PLAN });
    const page = await gate.run({ ...request(probe), limit: 5 });
    expect(page.items).toEqual([{ unreadable: { rows: '2' } }]);
  });

  it.each([
    ['an entity type the mapping does not hold', { entityType: 'ghost', relationshipType: 'MADE BY' }],
    ['a relationship type the mapping does not hold', { entityType: 'person', relationshipType: 'GHOST' }],
    ['a list of relationship types', { entityType: 'person', relationshipType: ['MADE BY'] }],
    ['an extra parameter', { ...probe, filter: 'x' }],
    ['no parameter', {}],
    ['a label instead of an entity type', { entityType: 'Order Person', relationshipType: 'MADE BY' }],
  ])('refuses %s with INVALID_REQUEST and reaches no source', async (_name, params) => {
    const { gate, executor } = rig();
    await expect(gate.run(request(params))).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(executor.calls).toEqual([]);
  });

  it('fails as any read does when the server refuses the statement', async () => {
    const { gate } = rig({ status: 'unavailable', reason: 'refused' });
    await expect(gate.run(request(probe))).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE', reason: 'refused' });
  });

  it('times out as any read does', async () => {
    const { gate } = rig({ status: 'timeout' });
    await expect(gate.run(request(probe))).rejects.toMatchObject({ code: 'QUERY_TIMEOUT' });
  });
});
