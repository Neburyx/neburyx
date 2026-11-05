import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NEO4J_SERIES, runAll } from '../../testing/neo4j-server.js';
import { itemsOf, madeRecordCount, startPackServers, withMadeRecords, type PackServer } from '../../testing/normalization-capture.js';
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

