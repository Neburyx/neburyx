import type { GraphNode } from '@neburyx/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSourceGate, type SourceGate } from '../gate/source-gate.js';
import { normalizeModelOf } from '../gate/normalize/model.js';
import { normalizeRows } from '../gate/normalize/index.js';
import { communitySeams } from '../seams/community-seams.js';
import { LOCAL_PRINCIPAL } from '../testing/gate.js';
import { NEO4J_SERIES, runAdmin, runAll } from '../testing/neo4j-server.js';
import { itemsOf, removeMadeRecords, startPackServers, type PackServer } from '../testing/normalization-capture.js';
import { PACKS } from '../testing/pack-fixtures.js';
import { communityAccess } from '../testing/source-access.js';
import { createSearchService } from './search-service.js';

interface Open {
  readonly target: PackServer;
  readonly gate: SourceGate;
}

let opened: Open[] = [];

beforeAll(async () => {
  const servers = await startPackServers();
  opened = servers.map((target) => {
    const defaults = communitySeams();
    const env = { DEMO_NEO4J_USER: target.server.reader.user, DEMO_NEO4J_PASSWORD: target.server.reader.password };
    const gate = createSourceGate({
      mapping: { sources: [target.source] },
      env,
      seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: { record: () => Promise.resolve() } },
      logger: { warn: () => undefined },
    });
    return { target, gate };
  });
}, 900_000);

afterAll(async () => {
  await runAll(opened.flatMap(({ target, gate }) => [() => gate.close(), () => target.close(), () => target.server.stop()]));
});

const quote = (name: string): string => `\`${name}\``;

describe.each(PACKS)(`the type-ahead search of the %s pack on ${NEO4J_SERIES}`, (pack) => {
  function current(): Open {
    const found = opened.find((candidate) => candidate.target.pack === pack);
    if (found === undefined) throw new Error('no server');
    return found;
  }
  const typeahead = (text: string, mask = false) =>
    createSearchService({ gate: current().gate.gate, indexes: current().gate.indexes, mapping: { sources: [current().target.source] }, access: communityAccess({ sources: [current().target.source] }) }).search({
      traceId: 'tr-typeahead-demo',
      principal: LOCAL_PRINCIPAL,
      sourceId: current().target.source.id,
      text,
      mask,
      typeahead: true,
    });

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

  const node = (label: string, properties: Record<string, string>, marker: string): string =>
    `(:${quote(label)} {${Object.entries({ ...properties, zzMarker: `'${marker}'` }).map(([key, value]) => `${key === 'zzMarker' ? key : quote(key)}: ${value}`).join(', ')}})`;

  it('finds, by the start of its stable ID, the node the Normalization suite builds from the same record, with only mapped properties, and puts a whole ID in the exact group only', async () => {
    const { source } = current().target;
    let checked = 0;
    for (const entity of source.entities.filter((candidate) => candidate.search.includes(candidate.stableId) && !candidate.pii.includes(candidate.stableId))) {
      const [row] = await itemsOf(current().target, 'capture-node', { entityType: entity.type });
      if (row === undefined) continue;
      const expected = expectedFrom(row);
      const id = expected.ref.stableId;
      if (Array.from(id).length < 3) continue;
      const start = Array.from(id).slice(0, Math.max(2, Array.from(id).length - 1)).join('');
      const byStart = await typeahead(start);
      const found = byStart.startsWith?.nodes.find((hit) => hit.ref.entityType === entity.type && hit.ref.stableId === id);
      expect(found, `${entity.type} by ${start}`).toEqual(expected);
      expect(byStart.exact.some((hit) => hit.ref.entityType === entity.type && hit.ref.stableId === id), entity.type).toBe(false);
      const projection = new Set(normalizeModelOf(source).entitiesByType.get(entity.type)?.projection);
      expect(found?.properties.every((property) => projection.has(property.key)), entity.type).toBe(true);
      const whole = await typeahead(id);
      expect(whole.exact.some((hit) => hit.ref.entityType === entity.type && hit.ref.stableId === id), `${entity.type} by ${id}`).toBe(true);
      expect(whole.startsWith?.nodes.some((hit) => hit.ref.entityType === entity.type && hit.ref.stableId === id), `${entity.type} by ${id}`).toBe(false);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('leaves a personal-data search property out of a masked type-ahead search, finds an entity through it when not masked, and never shows its value while masked', async () => {
    const entity = current().target.source.entities.find((candidate) => candidate.search.some((property) => candidate.pii.includes(property)) && candidate.search.some((property) => !candidate.pii.includes(property)));
    if (entity === undefined) throw new Error('the pack has no entity type with a personal-data and a plain search property');
    const personal = entity.search.find((property) => entity.pii.includes(property));
    const eligible = entity.search.find((property) => !entity.pii.includes(property));
    if (personal === undefined || eligible === undefined) throw new Error('unreachable');
    const start = 'ZZ-OVERLAP';
    const create = `CREATE ${node(entity.label, { [entity.stableId]: "'ZZ-OVL-1'", [personal]: `'${start}-PERSONAL'` }, 'o1')}, ${node(entity.label, { [entity.stableId]: "'ZZ-OVL-2'", [personal]: "'Someone Else'", [eligible]: `'${start}-ELIGIBLE'` }, 'o2')}`;
    await withMade(create, async () => {
      const plain = await typeahead(start);
      const plainIds = (plain.startsWith?.nodes ?? []).map((hit) => hit.ref.stableId);
      expect(plainIds).toContain('ZZ-OVL-1');
      expect(plainIds).toContain(eligible === entity.stableId ? `${start}-ELIGIBLE` : 'ZZ-OVL-2');
      const masked = await typeahead(start, true);
      const maskedIds = (masked.startsWith?.nodes ?? []).map((hit) => hit.ref.stableId);
      expect(maskedIds).not.toContain('ZZ-OVL-1');
      expect(maskedIds).toContain(eligible === entity.stableId ? `${start}-ELIGIBLE` : 'ZZ-OVL-2');
      expect(JSON.stringify(masked)).not.toContain(`${start}-PERSONAL`);
      expect(JSON.stringify(masked)).not.toContain('Someone Else');
    });
  });
});
