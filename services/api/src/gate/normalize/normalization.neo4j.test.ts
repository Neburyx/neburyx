import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isKeyed } from '../../mapping/model.js';
import { NEO4J_SERIES, runAdmin, runAll } from '../../testing/neo4j-server.js';
import { gateRequest } from '../../testing/gate.js';
import { itemsOf, madeRecordCount, removeMadeRecords, startPackServers, withMadeRecords, type PackServer } from '../../testing/normalization-capture.js';
import { ENTITY_LOAD_ID } from '../templates/entity-load.js';
import { normalizeModelOf } from './model.js';
import { normalizeRows } from './index.js';
import { normalizedOf } from '../../testing/search-fixtures.js';
import { canonicalise, PACKS, readFixture, updating, writeFixture, type Fixture } from '../../testing/pack-fixtures.js';

const image = NEO4J_SERIES;
let servers: PackServer[] = [];

beforeAll(async () => {
  servers = await startPackServers();
}, 900_000);

afterAll(async () => {
  await runAll([...servers.map((target) => () => target.close()), ...servers.map((target) => () => target.server.stop())]);
});

/** Every capture of a pack, by name; each is the rows the adapter handed to the gate, with element IDs named in order. */
async function captureAll(target: PackServer): Promise<Fixture> {
  const [entity] = target.source.entities;
  if (entity === undefined) throw new Error('the pack has no entity type');
  const [relationship] = target.source.relationships;
  if (relationship === undefined) throw new Error('the pack has no relationship');
  const captured: Fixture = {
    node: await itemsOf(target, 'capture-node', { entityType: entity.type }),
    values: await itemsOf(target, 'capture-values', {}),
    relationship: await itemsOf(target, 'capture-relationship', { entityType: relationship.from, otherType: relationship.to, relationshipType: relationship.type }),
  };
  // what the demo graph does not hold is made for the capture and removed after it, also when the capture fails
  // one node of each entity type that marks pii fields, for the redaction suite
  const marked = target.source.entities.filter((candidate) => candidate.pii.length > 0);
  const piiNodes: Record<string, unknown>[] = [];
  for (const candidate of marked) piiNodes.push(...(await itemsOf(target, 'capture-node', { entityType: candidate.type })));
  captured['piiNodes'] = piiNodes;
  const keyed = target.source.relationships.find((candidate) => candidate.stableId !== undefined);
  if (keyed === undefined) throw new Error('the pack maps no relationship with a stable ID');
  // the first two relationship rows of the mapping that chain: the second starts where the first ends
  const chain = target.source.relationships.flatMap((first) => target.source.relationships.filter((second) => second.from === first.to).map((second) => ({ first, second })))[0];
  if (chain === undefined) throw new Error('the pack maps no chain of two relationships');
  const { first, second } = chain;
  captured['path'] = await itemsOf(target, 'capture-path', { entityType: first.from, middleType: first.to, lastType: second.to, firstType: first.type, secondType: second.type });
  const [rule] = target.source.derived;
  if (rule === undefined) throw new Error('the pack maps no derived rule');
  const [firstType, middleType, secondType] = rule.via;
  captured['supports'] = await itemsOf(target, 'capture-supports', { entityType: rule.from, middleType: middleType ?? '', lastType: rule.to, firstType: firstType ?? '', secondType: secondType ?? '' });
  captured['stored'] = await itemsOf(target, 'capture-relationship', { entityType: keyed.from, otherType: keyed.to, relationshipType: keyed.type });
  // the rows of the real expansion statement for a relationship that has a stable ID and for one that has none, each read from the demo graph through the gate
  const expansionOf = async (row: (typeof target.source.relationships)[number]) => {
    const anchor = target.source.entities.find((candidate) => candidate.type === row.from);
    const items = await itemsOf(target, 'capture-relationship', { entityType: row.from, otherType: row.to, relationshipType: row.type });
    const node = items.map((item) => item['a']).find((value): value is { properties: Record<string, unknown> } => typeof value === 'object' && value !== null && 'properties' in value);
    const stableId = anchor === undefined || node === undefined ? undefined : node.properties[anchor.stableId];
    if (typeof stableId !== 'string' && typeof stableId !== 'number') throw new Error('the pack has no node to expand');
    return (await target.expand({ entityType: row.from, stableId: String(stableId), neighborType: row.to })).rows;
  };
  const unkeyed = target.source.relationships.find((candidate) => candidate.stableId === undefined);
  if (unkeyed === undefined) throw new Error('the pack maps no relationship without a stable ID');
  captured['expansionStored'] = await expansionOf(keyed);
  captured['expansionAggregate'] = await expansionOf(unkeyed);
  // one set of made records for both reads: a server may give the element ID of a deleted record to a new one, and the capture names element IDs by their string
  await withMadeRecords(target, async () => {
    captured['made'] = await itemsOf(target, 'capture-made', {});
    captured['members'] = await itemsOf(target, 'capture-members', {});
  });
  return canonicalise(captured);
}

describe.each(PACKS)(`the captured records of the %s pack on ${image}`, (pack) => {
  it('equal the committed fixtures, or are written when the update flag is set', async () => {
    const target = servers.find((candidate) => candidate.pack === pack);
    if (target === undefined) throw new Error('no server');
    const captured = await captureAll(target);
    if (updating()) {
      writeFixture(pack, captured);
      return;
    }
    const committed = readFixture(pack);
    expect(captured, `the capture differs from tools/demo-graph/fixtures/normalization/${pack}.json:\ncaptured ${JSON.stringify(captured)}\ncommitted ${JSON.stringify(committed)}`).toEqual(committed);
  });
});

describe(`rows from the real adapter on ${image}`, () => {
  it('are plain: the same read twice gives equal rows, and a row survives a JSON round trip unchanged', async () => {
    const [target] = servers;
    if (target === undefined) throw new Error('no server');
    const first = await itemsOf(target, 'capture-values', {});
    const second = await itemsOf(target, 'capture-values', {});
    expect(second).toEqual(first);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
    expect(JSON.stringify(first)).toContain('9223372036854775807');
  });

  it('hand the gate a row with its values converted', async () => {
    const [target] = servers;
    if (target === undefined) throw new Error('no server');
    const page = await target.system.run({ traceId: 'tr-values', sourceId: target.source.id, templateId: 'capture-values', params: {}, limit: 1 });
    const [row] = page.items;
    expect(row).toMatchObject({ smallInteger: 7, bigInteger: { $type: 'integer', value: '9223372036854775807' }, nothing: null });
  });
});

describe(`the records the capture makes on ${image}`, () => {
  it('are all removed afterwards, also when the capture fails', async () => {
    for (const target of servers) {
      expect(await madeRecordCount(target)).toBe(0);
      const failure = await withMadeRecords(target, async () => {
        expect(await madeRecordCount(target)).toBe(5);
        throw new Error('the capture failed');
      }).catch((error: unknown) => error);
      expect(failure).toMatchObject({ message: 'the capture failed' });
      expect(await madeRecordCount(target)).toBe(0);
    }
  });
});


/** Two entity types of the pack whose stable IDs are not keyed, so the entity read takes the value itself. */
function twoPlainTypes(target: PackServer) {
  const [first, second] = target.source.entities.filter((entity) => !isKeyed(entity));
  if (first === undefined || second === undefined) throw new Error('the pack has fewer than two entity types that are not keyed');
  return { first, second };
}

const quoted = (name: string): string => `\`${name}\``;


describe(`a node of two mapped labels, read through the real adapter and the gate on ${image}`, () => {
  it('is the type the entity read names, for each of the two types, and is left out as ambiguous by a read that names no type', async () => {
    const [target] = servers;
    if (target === undefined) throw new Error('no server');
    const { first, second } = twoPlainTypes(target);
    await runAdmin(target.server, `CREATE (:${quoted(first.label)}:${quoted(second.label)} {zzMarker: 'two-labels', ${quoted(first.stableId)}: 'ZZ-TWO-1', ${quoted(second.stableId)}: 'ZZ-TWO-2'})`);
    try {
      const asFirst = await target.gate.run(gateRequest({ sourceId: target.source.id, templateId: ENTITY_LOAD_ID, params: { entityType: first.type, stableId: 'ZZ-TWO-1' }, limit: 1 }));
      expect(normalizedOf(asFirst).nodes.map((node) => node.ref)).toEqual([{ sourceId: target.source.id, entityType: first.type, stableId: 'ZZ-TWO-1' }]);
      const asSecond = await target.gate.run(gateRequest({ sourceId: target.source.id, templateId: ENTITY_LOAD_ID, params: { entityType: second.type, stableId: 'ZZ-TWO-2' }, limit: 1 }));
      expect(normalizedOf(asSecond).nodes.map((node) => node.ref)).toEqual([{ sourceId: target.source.id, entityType: second.type, stableId: 'ZZ-TWO-2' }]);
      const rows = await itemsOf(target, 'capture-marked', { marker: 'two-labels' });
      const unasked = normalizeRows({ sourceId: target.source.id, hasMore: false, model: normalizeModelOf(target.source) }, rows);
      expect(unasked.nodes).toEqual([]);
      expect(unasked.dropped['ambiguous-type']).toBe(1);
    } finally {
      await removeMadeRecords(target);
    }
  });
});

describe(`a node whose stable ID is a float, read through the real adapter and the gate on ${image}`, () => {
  it('is an unreferenced record when the float has a fraction, with no element ID in it, and the entity read finds no row for its text', async () => {
    const [target] = servers;
    if (target === undefined) throw new Error('no server');
    const { first } = twoPlainTypes(target);
    await runAdmin(target.server, `CREATE (:${quoted(first.label)} {zzMarker: 'float-id', ${quoted(first.stableId)}: 7.5})`);
    try {
      const rows = await itemsOf(target, 'capture-marked', { marker: 'float-id' });
      const normalized = normalizeRows({ sourceId: target.source.id, hasMore: false, model: normalizeModelOf(target.source) }, rows);
      expect(normalized.nodes).toEqual([]);
      expect(normalized.unreferenced).toEqual([expect.objectContaining({ entityType: first.type, reason: 'no-stable-id' })]);
      expect(normalized.unreferenced[0]?.properties.find((property) => property.key === first.stableId)).toMatchObject({ value: 7.5, dataClass: 'number' });
      const plain = rows[0]?.['n'];
      const elementId = typeof plain === 'object' && plain !== null && 'elementId' in plain ? String(plain.elementId) : '';
      expect(elementId).not.toBe('');
      expect(JSON.stringify(normalized.unreferenced)).not.toContain(elementId);
      expect(normalized.dropped['no-stable-id']).toBe(1);
      const failure = await target.gate.run(gateRequest({ sourceId: target.source.id, templateId: ENTITY_LOAD_ID, params: { entityType: first.type, stableId: '7.5' }, limit: 1 })).then(
        (page) => normalizedOf(page).nodes,
        (error: unknown) => error,
      );
      expect(failure).toEqual([]);
    } finally {
      await removeMadeRecords(target);
    }
  });

  it('reads a whole-number float as the integer it equals, which the entity read finds again by that integer', async () => {
    const [target] = servers;
    if (target === undefined) throw new Error('no server');
    const { first } = twoPlainTypes(target);
    await runAdmin(target.server, `CREATE (:${quoted(first.label)} {zzMarker: 'whole-float-id', ${quoted(first.stableId)}: 7.0})`);
    try {
      const rows = await itemsOf(target, 'capture-marked', { marker: 'whole-float-id' });
      const normalized = normalizeRows({ sourceId: target.source.id, hasMore: false, model: normalizeModelOf(target.source) }, rows);
      expect(normalized.nodes.map((node) => node.ref.stableId)).toEqual(['7']);
      const page = await target.gate.run(gateRequest({ sourceId: target.source.id, templateId: ENTITY_LOAD_ID, params: { entityType: first.type, stableId: '7' }, limit: 1 }));
      expect(normalizedOf(page).nodes.map((node) => node.ref)).toEqual([{ sourceId: target.source.id, entityType: first.type, stableId: '7' }]);
    } finally {
      await removeMadeRecords(target);
    }
  });
});
