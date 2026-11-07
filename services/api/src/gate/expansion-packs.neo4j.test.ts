import { edgeSchema, nodeSchema } from '@neburyx/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOCAL_PRINCIPAL, gateRequest } from '../testing/gate.js';
import { NEO4J_SERIES, runAll } from '../testing/neo4j-server.js';
import { itemsOf, startPackServers, type PackServer } from '../testing/normalization-capture.js';
import { PACKS } from '../testing/pack-fixtures.js';
import type { ExpansionPage } from './normalize/expansion.js';
import { ownValue } from './normalize/node.js';
import { EXPAND_NEIGHBORS_ID } from './templates/expand-neighbors.js';

let servers: PackServer[] = [];

beforeAll(async () => {
  servers = await startPackServers();
}, 900_000);

afterAll(async () => {
  await runAll([...servers.map((target) => () => target.close()), ...servers.map((target) => () => target.server.stop())]);
});

const isNode = (value: unknown): value is { readonly properties: Record<string, unknown> } => typeof value === 'object' && value !== null && 'properties' in value && typeof value.properties === 'object' && value.properties !== null;

describe.each(PACKS)(`the Normalization and Redaction suites on the expansion of the %s pack on ${NEO4J_SERIES}`, (pack) => {
  async function expand(target: PackServer, entityType: string, stableId: string, neighborType: string, mask: boolean) {
    const page = await target.gate.run(
      gateRequest({ sourceId: target.source.id, principal: LOCAL_PRINCIPAL, templateId: EXPAND_NEIGHBORS_ID, params: { entityType, stableId, neighborType, direction: 'both', sort: 'observed' }, limit: 25, mask }),
    );
    return page.items[0] as unknown as ExpansionPage;
  }

  it('shapes every relationship and neighbor of each mapped row as the contracts say, loses none to a named reason, and masks a masked request', async () => {
    const target = servers.find((candidate) => candidate.pack === pack);
    if (target === undefined) throw new Error('no server');
    const piiOf = new Map(target.source.entities.map((entity) => [entity.type, entity.pii]));
    let shaped = 0;
    let masked = 0;
    for (const row of target.source.relationships) {
      const rows = await itemsOf(target, 'capture-relationship', { entityType: row.from, otherType: row.to, relationshipType: row.type });
      const found = rows.flatMap((item) => (isNode(item['a']) ? [item['a']] : []));
      const anchorEntity = target.source.entities.find((entity) => entity.type === row.from);
      const first = found[0];
      if (anchorEntity === undefined || first === undefined) continue;
      const stableId = ownValue(first.properties, anchorEntity.stableId);
      if (typeof stableId !== 'string' && typeof stableId !== 'number') continue;
      const plain = await expand(target, row.from, String(stableId), row.to, false);
      const hidden = await expand(target, row.from, String(stableId), row.to, true);
      expect(plain.anchorFound).toBe(true);
      expect(plain.edges.length).toBeGreaterThan(0);
      for (const node of plain.nodes) expect(nodeSchema.safeParse(node).success).toBe(true);
      for (const edge of plain.edges) {
        expect(edgeSchema.safeParse(edge).success).toBe(true);
        expect(['out', 'in']).toContain(edge.direction);
        expect(plain.nodes.some((node) => node.ref.entityType === edge.from.entityType && node.ref.stableId === edge.from.stableId)).toBe(true);
        expect(plain.nodes.some((node) => node.ref.entityType === edge.to.entityType && node.ref.stableId === edge.to.stableId)).toBe(true);
      }
      expect(Object.entries(plain.dropped).filter(([reason, count]) => reason.startsWith('end-') && count > 0)).toEqual([]);
      for (const node of hidden.nodes) {
        for (const property of node.properties) {
          if (piiOf.get(node.ref.entityType)?.includes(property.key) === true && property.value !== undefined) {
            expect(property.masked).toBe(true);
            masked += 1;
          }
        }
      }
      shaped += 1;
    }
    expect(shaped).toBeGreaterThan(0);
    expect(masked).toBeGreaterThan(0);
  });
});
