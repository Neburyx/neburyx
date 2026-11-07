import { z } from 'zod';
import type { TemplateDefinition } from '../gate/catalog.js';
import type { MappingModel } from '../mapping/model.js';
import { parseMapping } from '../mapping/load.js';
import type { AuditEvent, Seams } from '../seams/seams.js';
import { communitySeams } from '../seams/community-seams.js';
import { baseSource, fileOf, type Json } from './mapping.js';

export function sourceWith(id: string, overrides: Json = {}): Json {
  return baseSource({
    id,
    entities: [
      { type: 'person', label: 'Person', stable_id: 'id' },
      { type: 'order_line', label: 'Order Line', stable_id: 'id' },
    ],
    relationships: [
      { type: 'KNOWS', from: 'person', to: 'person' },
      { type: 'HAS LINE', from: 'person', to: 'order_line' },
    ],
    ...overrides,
  });
}

export function mappingOf(...sources: Json[]): MappingModel {
  return parseMapping(fileOf(...sources), 'neburyx.yaml');
}

export function auditing(): { readonly seams: Pick<Seams, 'policy' | 'coordinator' | 'audit'>; readonly events: AuditEvent[]; readonly asked: number[] } {
  const events: AuditEvent[] = [];
  const asked: number[] = [];
  const defaults = communitySeams();
  return {
    events,
    asked,
    seams: {
      policy: { authorizeSource: (request) => (asked.push(1), defaults.policy.authorizeSource(request)) },
      coordinator: defaults.coordinator,
      audit: { record: (event) => (events.push(event), Promise.resolve()) },
    },
  };
}

const looseText = z.unknown();

export const markerTemplate: TemplateDefinition = {
  id: 'marker-read',
  version: '1',
  auditAction: 'test.marker',
  cypher: 'MATCH (n:@entity(kind))-[r:@relationship(via)]->(m) RETURN n.id AS id LIMIT $limit + 1',
  paramsSchema: z.strictObject({ kind: looseText, via: looseText, ref: z.strictObject({ sourceId: z.string(), entityType: z.string(), stableId: z.string() }).optional() }),
  scope: 'user',
  paged: true,
  entityParams: ['kind'],
  relationshipParams: ['via'],
  refsOf: (params) => {
    const ref = z.strictObject({ sourceId: z.string(), entityType: z.string(), stableId: z.string() }).safeParse(params['ref']);
    return ref.success ? [ref.data] : [];
  },
  normalize: (rows) => rows.map((row) => ({ id: String(row['id']) })),
};

export const nodesTemplate: TemplateDefinition = {
  id: 'nodes-read',
  version: '1',
  auditAction: 'test.nodes',
  cypher: 'MATCH (n:@entity(kind)) RETURN n.id AS id ORDER BY id LIMIT $limit + 1',
  paramsSchema: z.strictObject({ kind: looseText }),
  scope: 'user',
  paged: true,
  entityParams: ['kind'],
  relationshipParams: [],
  refsOf: () => [],
  normalize: (rows) => rows.map((row) => ({ id: String(row['id']) })),
};

export const integerTemplate: TemplateDefinition = {
  id: 'integer-read',
  version: '1',
  auditAction: 'test.integer',
  cypher: 'RETURN valueType($k) AS t',
  paramsSchema: z.strictObject({ k: z.number().int() }),
  scope: 'user',
  paged: false,
  rows: 'one',
  entityParams: [],
  relationshipParams: [],
  refsOf: () => [],
  normalize: (rows) => rows.map((row) => ({ t: String(row['t']) })),
};
