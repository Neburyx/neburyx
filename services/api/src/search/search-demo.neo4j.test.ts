import type { GraphNode } from '@neburyx/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSourceGate, type SourceGate } from '../gate/source-gate.js';
import { normalizeModelOf } from '../gate/normalize/model.js';
import { normalizeRows } from '../gate/normalize/index.js';
import { communitySeams } from '../seams/community-seams.js';
import type { AuditEvent } from '../seams/seams.js';
import { LOCAL_PRINCIPAL } from '../testing/gate.js';
import { NEO4J_SERIES, runAdmin, runAll } from '../testing/neo4j-server.js';
import { itemsOf, removeMadeRecords, startPackServers, type PackServer } from '../testing/normalization-capture.js';
import { PACKS } from '../testing/pack-fixtures.js';
import { communityAccess } from '../testing/source-access.js';
import { ALWAYS_USABLE } from '../testing/usability.js';
import { createSearchService } from './search-service.js';

interface Open {
  readonly target: PackServer;
  readonly gate: SourceGate;
  readonly events: AuditEvent[];
}

let opened: Open[] = [];

beforeAll(async () => {
  const servers = await startPackServers();
  opened = servers.map((target) => {
    const events: AuditEvent[] = [];
    const defaults = communitySeams();
    const env = { DEMO_NEO4J_USER: target.server.reader.user, DEMO_NEO4J_PASSWORD: target.server.reader.password };
    const gate = createSourceGate({
      mapping: { sources: [target.source] },
      env,
      seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: { record: (event) => Promise.resolve(void events.push(event)) } },
      logger: { warn: () => undefined },
      usability: ALWAYS_USABLE,
    });
    return { target, gate, events };
  });
}, 900_000);

afterAll(async () => {
  await runAll(opened.flatMap(({ target, gate }) => [() => gate.close(), () => target.close(), () => target.server.stop()]));
});

const quote = (name: string): string => `\`${name}\``;

describe.each(PACKS)(`the search of the %s pack on ${NEO4J_SERIES}`, (pack) => {
  function current(): Open {
    const found = opened.find((candidate) => candidate.target.pack === pack);
    if (found === undefined) throw new Error('no server');
    return found;
  }
  const search = (text: string, mask = false) =>
    createSearchService({ gate: current().gate.gate, indexes: current().gate.indexes, mapping: { sources: [current().target.source] }, access: communityAccess({ sources: [current().target.source] }) }).search({ traceId: 'tr-search-demo', principal: LOCAL_PRINCIPAL, sourceId: current().target.source.id, text, mask });
  const hitsOf = async (text: string, mask = false): Promise<GraphNode[]> => (await search(text, mask)).exact;

  function expectedFrom(row: Record<string, unknown>): GraphNode {
    const [node] = normalizeRows({ sourceId: current().target.source.id, hasMore: false, model: normalizeModelOf(current().target.source) }, [row]).nodes;
    if (node === undefined) throw new Error('the captured record is not a node of the mapping');
    return node;
  }

  async function withMade<T>(create: string, work: () => Promise<T>): Promise<T> {
    await removeMadeRecords(current().target);
    try {
      await runAdmin(current().target.server, create);
      return await work();
    } finally {
      await removeMadeRecords(current().target);
    }
  }

  /** An entity type with a search property that is not its stable ID and not personal data, so a made node can hold a value there without being its identity. */
  function plainTarget() {
    for (const entity of current().target.source.entities) {
      const property = entity.search.find((candidate) => candidate !== entity.stableId && !entity.pii.includes(candidate));
      if (property !== undefined) return { entity, property };
    }
    throw new Error('the pack has no such search property');
  }

  const made = (label: string, stableId: string, id: string, property: string, value: string, marker: string): string =>
    `(:${quote(label)} {${quote(stableId)}: '${id}', ${quote(property)}: ${value}, zzMarker: '${marker}'})`;

  /** A node with the given properties written as a Cypher map; a name given twice keeps its last value, so a property that is also the stable ID is written once. */
  const node = (label: string, properties: Record<string, string>, marker: string): string =>
    `(:${quote(label)} {${Object.entries({ ...properties, zzMarker: `'${marker}'` }).map(([key, value]) => `${key === 'zzMarker' ? key : quote(key)}: ${value}`).join(', ')}})`;

  it('finds, for an entity of every type that has a search property, the node the Normalization suite builds from the same record, with only mapped properties', async () => {
    const { source } = current().target;
    const searchable = source.entities.filter((entity) => entity.search.length > 0);
    expect(searchable.length).toBeGreaterThan(0);
    for (const entity of searchable) {
      const [row] = await itemsOf(current().target, 'capture-node', { entityType: entity.type });
      if (row === undefined) throw new Error(`the demo graph holds no ${entity.type}`);
      const expected = expectedFrom(row);
      const candidates = [...new Set([...(entity.search.includes(entity.stableId) ? [entity.stableId] : []), ...entity.search])];
      let found: GraphNode | undefined;
      for (const property of candidates) {
        const value = expected.properties.find((candidate) => candidate.key === property)?.value;
        if (typeof value !== 'string' && typeof value !== 'number') continue;
        found = (await hitsOf(String(value))).find((hit) => hit.ref.entityType === entity.type && hit.ref.stableId === expected.ref.stableId);
        if (found !== undefined) break;
      }
      expect(found, entity.type).toEqual(expected);
      const projection = new Set(normalizeModelOf(source).entitiesByType.get(entity.type)?.projection);
      expect(found?.properties.every((property) => projection.has(property.key)), entity.type).toBe(true);
    }
  });

  it('finds a made entity by its whole value only, as stored: other case, a prefix, a longer value and a trailing space find nothing', async () => {
    const { entity, property } = plainTarget();
    await withMade(`CREATE ${made(entity.label, entity.stableId, 'ZZ-CASE-1', property, "'AC-1'", 'c1')}`, async () => {
      expect((await hitsOf('AC-1')).map((hit) => hit.ref.stableId)).toEqual(['ZZ-CASE-1']);
      for (const text of ['ac-1', 'AC-', 'AC-10', 'AC-1 ']) expect(await hitsOf(text), text).toEqual([]);
    });
  });

  it('finds an integer value and a text value with the same digits, an integer at each end of 64 bits exactly, and the noncanonical texts as text only', async () => {
    const { entity, property } = plainTarget();
    const rows = [
      ['ZZ-INT-1', '123'],
      ['ZZ-INT-2', "'123'"],
      ['ZZ-INT-3', '9223372036854775807'],
      ['ZZ-INT-4', '-9223372036854775808'],
      ['ZZ-INT-5', '7'],
      ['ZZ-INT-6', "'007'"],
    ];
    await withMade(`CREATE ${rows.map(([id, value], index) => made(entity.label, entity.stableId, id ?? '', property, value ?? '', `i${index}`)).join(', ')}`, async () => {
      expect((await hitsOf('123')).map((hit) => hit.ref.stableId).sort()).toEqual(['ZZ-INT-1', 'ZZ-INT-2']);
      expect((await hitsOf('9223372036854775807')).map((hit) => hit.ref.stableId)).toEqual(['ZZ-INT-3']);
      expect((await hitsOf('-9223372036854775808')).map((hit) => hit.ref.stableId)).toEqual(['ZZ-INT-4']);
      expect((await hitsOf('007')).map((hit) => hit.ref.stableId)).toEqual(['ZZ-INT-6']);
      for (const text of ['+7', '07', '7.0', '9223372036854775808']) expect(await hitsOf(text), text).toEqual([]);
    });
  });

  it('shows 24 and 25 matching entities as exact and 26 as a lower bound of 25', async () => {
    const { entity, property } = plainTarget();
    for (const [size, quality] of [[24, 'exact'], [25, 'exact'], [26, 'lowerBound']] as const) {
      const nodes = Array.from({ length: size }, (_, index) => made(entity.label, entity.stableId, `ZZ-BULK-${size}-${index}`, property, `'zz-bulk-${size}'`, `b${size}-${index}`));
      await withMade(`CREATE ${nodes.join(', ')}`, async () => {
        const result = await search(`zz-bulk-${size}`);
        expect(result.exact).toHaveLength(Math.min(size, 25));
        expect(result.counts.exact).toMatchObject({ value: Math.min(size, 25), quality });
      });
    }
  });

  it('shows an entity that matches through two properties once, in one audited read', async () => {
    const entity = current().target.source.entities.find((candidate) => candidate.search.filter((property) => !candidate.pii.includes(property)).length >= 2);
    if (entity === undefined) throw new Error('the pack has no entity type with two plain search properties');
    const [first, second] = entity.search.filter((property) => !entity.pii.includes(property));
    if (first === undefined || second === undefined) throw new Error('unreachable');
    const text = 'ZZ-DUAL';
    await withMade(`CREATE ${node(entity.label, { [entity.stableId]: `'${text}'`, [first]: `'${text}'`, [second]: `'${text}'` }, 'd1')}`, async () => {
      current().events.length = 0;
      const result = await search(text);
      expect(result.exact.map((hit) => hit.ref.stableId)).toEqual([text]);
      expect(result.counts.exact).toMatchObject({ value: 1, quality: 'exact' });
      expect(current().events.filter((event) => event.action === 'entity.search')).toHaveLength(1);
    });
  });

  it('leaves a personal-data search property out of a masked search and finds an entity through it when not masked, with the same result through the real adapter', async () => {
    const entity = current().target.source.entities.find((candidate) => candidate.search.some((property) => candidate.pii.includes(property)) && candidate.search.some((property) => !candidate.pii.includes(property)));
    if (entity === undefined) throw new Error('the pack has no entity type with a personal-data and a plain search property');
    const personal = entity.search.find((property) => entity.pii.includes(property));
    const eligible = entity.search.find((property) => !entity.pii.includes(property));
    if (personal === undefined || eligible === undefined) throw new Error('unreachable');
    const text = 'ZZ-OVERLAP-TEXT';
    const create = `CREATE ${node(entity.label, { [entity.stableId]: "'ZZ-OVL-1'", [personal]: `'${text}'` }, 'o1')}, ${node(entity.label, { [entity.stableId]: "'ZZ-OVL-2'", [personal]: "'Someone Else'", [eligible]: `'${text}'` }, 'o2')}`;
    await withMade(create, async () => {
      const plain = await hitsOf(text);
      const expectedIds = eligible === entity.stableId ? [text, 'ZZ-OVL-1'] : ['ZZ-OVL-1', 'ZZ-OVL-2'];
      expect(plain.map((hit) => hit.ref.stableId).sort()).toEqual(expectedIds.sort());
      const masked = await hitsOf(text, true);
      expect(masked.map((hit) => hit.ref.stableId)).toEqual([eligible === entity.stableId ? text : 'ZZ-OVL-2']);
      expect(masked[0]?.properties.find((property) => property.key === personal)).toMatchObject({ masked: true, maskedBy: 'request' });
      expect(JSON.stringify(masked)).not.toContain('Someone Else');
      expect(JSON.stringify(plain)).toContain('Someone Else');
    });
  });
});
