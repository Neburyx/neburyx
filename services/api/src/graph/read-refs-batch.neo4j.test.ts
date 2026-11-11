import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_READ_REFS } from '@neburyx/contracts';
import { type ProfiledPlan } from 'neo4j-driver';
import { allowlistFromMapping } from '../gate/allowlist.js';
import { assembleGate } from '../gate/assemble.js';
import { createTemplateCatalog } from '../gate/catalog.js';
import { renderTemplate } from '../gate/render.js';
import { EDGE_LOAD_ID } from '../gate/templates/edge-load.js';
import { edgeLoadManyTemplate } from '../gate/templates/edge-load-many.js';
import { ENTITY_LOAD_ID } from '../gate/templates/entity-load.js';
import { entityLoadManyTemplate } from '../gate/templates/entity-load-many.js';
import type { Gate } from '../gate/types.js';
import { makeToken } from '../reference/token.js';
import { communitySeams } from '../seams/community-seams.js';
import { createNeo4jExecutor, type Neo4jExecutor } from '../sources/executor.js';
import { prepareParameters } from '../sources/parameters.js';
import { LOCAL_PRINCIPAL, TEST_REFERENCE_KEYS } from '../testing/gate.js';
import { envFor, NEO4J_SERIES, runAdmin, runAll, sourceFor, startNeo4j, type RunningNeo4j } from '../testing/neo4j-server.js';
import { communityAccess } from '../testing/source-access.js';
import { createReadRefsService } from './read-refs-service.js';

/**
 * The reads of many references in one statement, against a real source: each answers what the single read answers for the same reference, for found, missing, duplicate, integer-valued and masked
 * references, and takes the whole list of a call in a few round trips.
 */
let server: RunningNeo4j;
let rig: { readonly gate: Gate; readonly close: () => Promise<void> };
/** The statements the source was asked, by template. */
const statements: string[] = [];

const entities = [
  { type: 'maker', label: 'XMaker', stable_id: 'makerId', title: '{makerName}', pii: [{ property: 'makerName', class: 'name' }] },
  { type: 'tool', label: 'XTool', stable_id: 'toolId' },
  { type: 'phone', label: 'XPhone', stable_id: 'phoneNumber', pii: [{ property: 'phoneNumber', class: 'phone' }] },
];
const relationships = [{ type: 'USES_TOOL', from: 'maker', to: 'tool', stable_id: 'useId' }];

const source = () => sourceFor(server, { entities, relationships });
const el = (entityType: string, stableId: string) => ({ sourceId: 'graph', entityType, stableId });
const PHONE = '+1-212-555-0100';

beforeAll(async () => {
  server = await startNeo4j();
  await runAdmin(server, 'CREATE INDEX x_maker FOR (n:XMaker) ON (n.makerId)');
  await runAdmin(server, 'CREATE INDEX x_tool FOR (n:XTool) ON (n.toolId)');
  await runAdmin(server, 'CREATE INDEX x_phone FOR (n:XPhone) ON (n.phoneNumber)');
  await runAdmin(server, `CREATE (:XPhone {phoneNumber: '${PHONE}'})`);
  await runAdmin(server, 'CREATE INDEX x_use FOR ()-[r:USES_TOOL]-() ON (r.useId)');
  // makers m0 … m119 (the ID of m7 is also held by a second node: a duplicate), makers with an integer ID, and a tool for each pair
  await runAdmin(server, "UNWIND range(0, 119) AS i CREATE (:XMaker {makerId: 'm' + toString(i), makerName: 'Ana ' + toString(i)})");
  await runAdmin(server, "CREATE (:XMaker {makerId: 'm7', makerName: 'Second Seven'}), (:XMaker {makerId: 9007199254740993, makerName: 'Big Number'}), (:XTool {toolId: 't1'})");
  await runAdmin(server, "UNWIND range(0, 119) AS i MATCH (a:XMaker {makerId: 'm' + toString(i), makerName: 'Ana ' + toString(i)}), (d:XTool {toolId: 't1'}) CREATE (a)-[:USES_TOOL {useId: 'u' + toString(i)}]->(d)");
  await runAdmin(server, "MATCH (a:XMaker {makerId: 'm3'}), (d:XTool {toolId: 't1'}) CREATE (a)-[:USES_TOOL {useId: 'u3'}]->(d)");
  await runAdmin(server, 'CALL db.awaitIndexes(120)');
  const mapping = { sources: [source()] };
  const defaults = communitySeams();
  const executor = createNeo4jExecutor({ sources: mapping.sources, env: envFor(server), logger: { warn: () => undefined } });
  const recording: Neo4jExecutor = { ...executor, execute: (call) => (statements.push(call.templateId), executor.execute(call)) };
  const assembled = assembleGate({ mapping, seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit }, executor: recording, logger: { warn: () => undefined }, referenceKeys: TEST_REFERENCE_KEYS });
  rig = { gate: assembled.gate, close: () => executor.close() };
}, 600_000);

afterAll(async () => {
  await runAll([() => rig?.close(), () => server?.stop()]);
});

function service() {
  const mapping = { sources: [source()] };
  return createReadRefsService({ gate: rig.gate, mapping, access: communityAccess(mapping), audit: { record: () => Promise.resolve() }, logger: { warn: () => undefined } });
}

const read = (request: { readonly entities?: unknown[]; readonly edges?: unknown[]; readonly mask?: boolean }) =>
  service().read({ traceId: 'tr-batch', principal: LOCAL_PRINCIPAL, request: { sourceId: 'graph', entities: [], edges: [], aggregates: [], derived: [], ...request } as never });

/** What the single read answers for a reference: the node or edge it returns, or nothing. */
async function single(templateId: string, params: Record<string, unknown>, mask = false) {
  const page = await rig.gate.run({ traceId: 'tr-single', principal: LOCAL_PRINCIPAL, sourceId: 'graph', templateId, params, limit: 1, mask });
  return page.items[0] as { readonly nodes: readonly unknown[]; readonly edges: readonly unknown[] };
}

describe(`a read of many entities in one statement against a real source, on ${NEO4J_SERIES}`, () => {
  it('answers a call of more references than one run holds, found and missing, in the order asked', async () => {
    const asked = Array.from({ length: MAX_READ_REFS }, (_unused, index) => el('maker', index % 4 === 3 ? `none${index}` : `m${index}`));
    const before = statements.filter((id) => id === 'entity-load-many').length;
    const answer = await read({ entities: asked });
    // the 100 references of one type are read in two statements, not in a hundred
    expect(statements.filter((id) => id === 'entity-load-many').length - before).toBe(2);
    const expected = asked.filter((ref) => !ref.stableId.startsWith('none'));
    expect(answer.nodes.map((node) => node.ref.stableId)).toEqual(expected.map((ref) => ref.stableId));
    expect(answer.missing.entities).toEqual(asked.filter((ref) => ref.stableId.startsWith('none')));
  });

  it('answers each reference as the single read does, node for node', async () => {
    const refs = ['m0', 'm1', 'm7', 'nobody', 'm119', '9007199254740993'].map((id) => el('maker', id));
    const batched = await read({ entities: refs });
    for (const ref of refs) {
      const one = await single(ENTITY_LOAD_ID, { entityType: ref.entityType, stableId: ref.stableId });
      const node = batched.nodes.find((candidate) => candidate.ref.stableId === ref.stableId);
      expect(node).toEqual(one?.nodes[0]);
    }
  });

  it('flags a node whose ID another node holds, and only that one, as the single read does', async () => {
    const answer = await read({ entities: [el('maker', 'm6'), el('maker', 'm7')] });
    expect(answer.nodes.map((node) => [node.ref.stableId, node.qualityFlags.includes('duplicate-stable-id')])).toEqual([
      ['m6', false],
      ['m7', true],
    ]);
  });

  it('finds a node whose ID is an integer by the text of it', async () => {
    const answer = await read({ entities: [el('maker', '9007199254740993')] });
    expect(answer.nodes.map((node) => node.ref.stableId)).toEqual(['9007199254740993']);
  });

  it('masks the personal-data fields of every node when asked, as the single read does', async () => {
    const answer = await read({ mask: true, entities: [el('maker', 'm1'), el('maker', 'm2')] });
    expect(JSON.stringify(answer)).not.toContain('Ana');
    for (const node of answer.nodes) expect(node).toEqual((await single(ENTITY_LOAD_ID, { entityType: 'maker', stableId: node.ref.stableId }, true))?.nodes[0]);
  });

  it('reads a keyed type by its token, gives the token back as the reference and holds the value out of a masked answer', async () => {
    const token = makeToken(TEST_REFERENCE_KEYS, { sourceId: 'graph', entityType: 'phone' }, PHONE);
    const plain = await read({ entities: [el('phone', token)] });
    expect(plain.nodes.map((node) => node.ref.stableId)).toEqual([token]);
    const masked = await read({ mask: true, entities: [el('phone', token)] });
    expect(masked.nodes.map((node) => node.ref.stableId)).toEqual([token]);
    expect(JSON.stringify(masked)).not.toContain(PHONE);
  });

  it('lists a type with no such node, and an ID of the other type, as missing', async () => {
    const answer = await read({ entities: [el('tool', 'm1'), el('maker', 't1'), el('tool', 't1')] });
    expect(answer.nodes.map((node) => node.ref.stableId)).toEqual(['t1']);
    expect(answer.missing.entities).toEqual([el('tool', 'm1'), el('maker', 't1')]);
  });
});

describe(`a read of many stored edges in one statement against a real source, on ${NEO4J_SERIES}`, () => {
  const ref = (stableId: string) => ({ sourceId: 'graph', type: 'USES_TOOL', from: 'maker', to: 'tool', stableId });

  it('answers a call of up to the most references, found and missing, in the order asked', async () => {
    const asked = Array.from({ length: MAX_READ_REFS }, (_unused, index) => ref(index % 5 === 4 ? `none${index}` : `u${index}`));
    const answer = await read({ edges: asked });
    expect(answer.edges.map((edge) => edge.ref)).toEqual(asked.filter((entry) => !entry.stableId.startsWith('none')));
    expect(answer.missing.edges).toEqual(asked.filter((entry) => entry.stableId.startsWith('none')));
  });

  it('answers each reference as the single read does, edge for edge, including the one with a second relationship of the same ID', async () => {
    const refs = ['u0', 'u3', 'u9', 'nobody'].map(ref);
    const batched = await read({ edges: refs });
    for (const entry of refs) {
      const one = await single(EDGE_LOAD_ID, { type: entry.type, from: entry.from, to: entry.to, stableId: entry.stableId });
      expect(batched.edges.find((candidate) => 'stableId' in candidate.ref && candidate.ref.stableId === entry.stableId)).toEqual(one?.edges[0]);
    }
    expect(batched.edges.find((edge) => 'stableId' in edge.ref && edge.ref.stableId === 'u3')?.qualityFlags).toContain('conflicting-duplicate');
  });
});

function operatorsOf(plan: ProfiledPlan): string[] {
  return [plan.operatorType, ...plan.children.flatMap(operatorsOf)];
}

/** The operators of the statement a batched template renders for a list of IDs, run under PROFILE as the admin login. */
async function profile(template: typeof entityLoadManyTemplate, params: Record<string, unknown>, ids: number): Promise<string[]> {
  const built = createTemplateCatalog({ templates: [template] }).find(template.id);
  if (built === undefined) throw new Error('the template is not in its catalog');
  const [model] = [source()];
  const rendered = renderTemplate(built, built.paramsSchema.parse(params), allowlistFromMapping(model), ids, 500);
  const session = server.admin.session({ database: server.database });
  try {
    const result = await session.run(`PROFILE ${rendered.cypher}`, prepareParameters(rendered.parameters, built.integerParameters));
    return result.summary.profile === false ? [] : operatorsOf(result.summary.profile);
  } finally {
    await session.close();
  }
}

describe(`the plan of a read of many references in one statement, on ${NEO4J_SERIES}`, () => {
  it('seeks the node of each ID in the stable ID index, and scans no label', async () => {
    const operators = await profile(entityLoadManyTemplate, { entityType: 'maker', refs: ['m1', 'm2', 'm3'].map((id) => el('maker', id)) }, 3);
    expect(operators.filter((name) => /NodeIndexSeek|NodeUniqueIndexSeek/.test(name)).length).toBeGreaterThan(0);
    expect(operators.filter((name) => /NodeByLabelScan|AllNodesScan|RelationshipTypeScan/.test(name))).toEqual([]);
  });

  it('seeks the relationship of each ID in the stable ID index, and scans no label or type', async () => {
    const operators = await profile(edgeLoadManyTemplate, { type: 'USES_TOOL', from: 'maker', to: 'tool', refs: ['u1', 'u2', 'u3'].map((stableId) => ({ stableId })) }, 3);
    expect(operators.filter((name) => /RelationshipIndexSeek/.test(name)).length).toBeGreaterThan(0);
    expect(operators.filter((name) => /NodeByLabelScan|AllNodesScan|RelationshipTypeScan/.test(name))).toEqual([]);
  });
});
