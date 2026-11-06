import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { assembleGate } from '../gate/assemble.js';
import { createTemplateCatalog, type TemplateDefinition } from '../gate/catalog.js';
import { createSourceGate, type SourceGate } from '../gate/source-gate.js';
import { degreeProbeItemSchema } from '../gate/templates/degree-probe.js';
import { entityLoadTemplate } from '../gate/templates/entity-load.js';
import type { SystemRunner } from '../gate/types.js';
import { createNeo4jExecutor, type Neo4jExecutor } from '../sources/executor.js';
import { communitySeams } from '../seams/community-seams.js';
import { LOCAL_PRINCIPAL } from '../testing/gate.js';
import { envFor, NEO4J_SERIES, runAdmin, runAll, sourceFor, startNeo4j, type RunningNeo4j } from '../testing/neo4j-server.js';
import { ALWAYS_USABLE } from '../testing/usability.js';
import { communityAccess } from '../testing/source-access.js';
import { createEntityReader } from './entity-reader.js';

const IDS = ['123', '9007199254740993', '-42', '9223372036854775807', '-9223372036854775808'];

let server: RunningNeo4j;
let parts: SourceGate;

const entities = [
  { type: 'held_by_constraint', label: 'HeldByConstraint', stable_id: 'itemId' },
  { type: 'held_by_index', label: 'HeldByIndex', stable_id: 'itemId' },
];

function source() {
  return sourceFor(server, { entities, relationships: [] });
}

beforeAll(async () => {
  server = await startNeo4j();
  await runAdmin(server, 'CREATE CONSTRAINT held_unique FOR (n:HeldByConstraint) REQUIRE n.itemId IS UNIQUE');
  await runAdmin(server, 'CREATE INDEX held_plain FOR (n:HeldByIndex) ON (n.itemId)');
  await runAdmin(server, 'UNWIND [123, 9007199254740993, -42, 9223372036854775807, -9223372036854775808] AS v CREATE (:HeldByConstraint {itemId: v}), (:HeldByIndex {itemId: v})');
  await runAdmin(server, "CREATE (:HeldByIndex {itemId: '123'}), (:HeldByIndex {itemId: '0123'}), (:HeldByConstraint {itemId: '0123'})");
  await runAdmin(server, 'CALL db.awaitIndexes(120)');
  const mapping = { sources: [source()] };
  const defaults = communitySeams();
  parts = createSourceGate({ mapping, env: envFor(server), seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit }, logger: { warn: () => undefined }, usability: ALWAYS_USABLE });
}, 600_000);

afterAll(async () => {
  await runAll([() => parts?.close(), () => server?.stop()]);
});

function read(entityType: string, stableId: string) {
  const mapping = { sources: [source()] };
  return createEntityReader({ gate: parts.gate, mapping, access: communityAccess(mapping) }).read({ traceId: 'tr-integer', principal: LOCAL_PRINCIPAL, sourceId: 'graph', entityType, stableId, mask: false });
}

async function notFound(entityType: string, stableId: string): Promise<boolean> {
  const failure = await read(entityType, stableId).catch((error: unknown) => error);
  return failure instanceof AppError && failure.code === 'NOT_FOUND';
}

describe(`an entity whose stable ID is an integer, on ${NEO4J_SERIES}`, () => {
  it.each(['held_by_constraint', 'held_by_index'])('is found on a type with %s, and its reference gives the ID text back', async (entityType) => {
    for (const id of IDS) {
      const node = await read(entityType, id);
      expect(node.ref, `${entityType} ${id}`).toEqual({ sourceId: 'graph', entityType, stableId: id });
      if (!(entityType === 'held_by_index' && id === '123')) expect(node.qualityFlags, `${entityType} ${id}`).not.toContain('duplicate-stable-id');
    }
  });

  it('keeps a value above the safe JavaScript range exact in the node it shows', async () => {
    const node = await read('held_by_constraint', '9007199254740993');
    expect(node.properties.find((property) => property.key === 'itemId')).toMatchObject({ value: '9007199254740993', dataClass: 'number' });
    const top = await read('held_by_index', '9223372036854775807');
    expect(top.properties.find((property) => property.key === 'itemId')?.value).toBe('9223372036854775807');
  });

  it('is not found by text that is not the canonical text of the integer, and is not an error', async () => {
    for (const text of ['+123', '1.0', ' 123', '123 ', '00123', '1e2', '0x7b', '９', '9223372036854775808', '-9223372036854775809']) {
      expect(await notFound('held_by_constraint', text), text).toBe(true);
    }
  });

  it('is found by its text where the source holds the ID as text', async () => {
    expect((await read('held_by_constraint', '0123')).ref.stableId).toBe('0123');
    expect((await read('held_by_index', '0123')).ref.stableId).toBe('0123');
  });

  it('is flagged when the source also holds the same ID as text', async () => {
    const node = await read('held_by_index', '123');
    expect(node.qualityFlags).toContain('duplicate-stable-id');
    expect(node.qualityFlags).not.toContain('conflicting-duplicate');
    const single = await read('held_by_constraint', '123');
    expect(single.qualityFlags).not.toContain('duplicate-stable-id');
  });
});

describe(`the statement of the entity read, profiled through the gate on ${NEO4J_SERIES}`, () => {
  const PROFILED_ID = 'test-entity-load-profiled';
  const profiledEntityLoad: TemplateDefinition = {
    ...entityLoadTemplate,
    id: PROFILED_ID,
    scope: 'system',
    profile: true,
    cypher: `PROFILE ${entityLoadTemplate.cypher}`,
    normalize: (_rows, plan = null) => [{ operators: plan }],
  };
  let profiling: { readonly system: SystemRunner; readonly executor: Neo4jExecutor };

  beforeAll(() => {
    const mapping = { sources: [source()] };
    const defaults = communitySeams();
    const executor = createNeo4jExecutor({ sources: mapping.sources, env: envFor(server), logger: { warn: () => undefined } });
    const { system } = assembleGate({ usability: ALWAYS_USABLE, mapping, seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit }, executor, logger: { warn: () => undefined }, catalog: createTemplateCatalog({ templates: [profiledEntityLoad] }) });
    profiling = { system, executor };
  });

  afterAll(async () => {
    await profiling?.executor.close();
  });

  // the server sends a plan only for a read that completed, and a read that fills its limit has not; five leaves room for the two nodes that carry '123' in the index-only type
  async function operatorsOf(entityType: string, stableId: string): Promise<string[]> {
    const page = await profiling.system.run({ traceId: 'tr-profile', sourceId: 'graph', templateId: PROFILED_ID, params: { entityType, stableId }, limit: 5 });
    return (degreeProbeItemSchema.parse(page.items[0]).operators ?? []).map((operator) => operator.name);
  }

  it.each([
    ['held_by_constraint', '123'],
    ['held_by_constraint', '9007199254740993'],
    ['held_by_constraint', 'a text that is no integer'],
    ['held_by_index', '123'],
    ['held_by_index', '-9223372036854775808'],
    ['held_by_index', 'a text that is no integer'],
  ])('seeks the index on %s for %s, with no scan of the label and no filter', async (entityType, stableId) => {
    const operators = await operatorsOf(entityType, stableId);
    expect(operators.some((operator) => /IndexSeek/.test(operator)), operators.join(' > ')).toBe(true);
    expect(operators.some((operator) => /NodeByLabelScan|AllNodesScan|NodeIndexScan/.test(operator)), operators.join(' > ')).toBe(false);
    expect(operators.some((operator) => /^Filter/.test(operator)), operators.join(' > ')).toBe(false);
  });
});
