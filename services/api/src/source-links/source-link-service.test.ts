import type { GraphNode } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { createSourceAccess } from '../investigations/source-access.js';
import { parseMapping } from '../mapping/load.js';
import { deriveReferenceKeys } from '../reference/keys.js';
import { makeToken } from '../reference/token.js';
import { communitySeams } from '../seams/community-seams.js';
import type { AuditEvent } from '../seams/seams.js';
import { memoryAppStore } from '../testing/app-store.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { createSourceLinkService } from './source-link-service.js';

const keys = deriveReferenceKeys(Buffer.alloc(32, 3));
const mapping = parseMapping(
  fileOf(baseSource({ id: 'demo', entities: [{ type: 'person', label: 'Person', stable_id: 'idNo', pii: [{ property: 'idNo', class: 'text' }], link: 'https://records.example.test/p/{idNo}', link_carries_value: true }], relationships: [] })),
  'neburyx.yaml',
);

const nodeWith = (token: string, masked: boolean): GraphNode => ({
  ref: { sourceId: 'demo', entityType: 'person', stableId: token },
  display: { title: 'Person', type: 'person' },
  properties: [{ key: 'idNo', value: masked ? '••••' : 'ID-1', dataClass: 'text', masked }],
  qualityFlags: [],
  provenanceRefs: [],
  authorization: { canInspect: true, canExport: true },
});

function noEdgeRead(): never {
  throw new Error('no edge read here');
}

async function open(node: GraphNode, mask = false) {
  const events: AuditEvent[] = [];
  const defaults = communitySeams();
  const service = createSourceLinkService({
    mapping,
    access: createSourceAccess({ mapping, seams: defaults, logger: { warn: () => undefined } }),
    entities: { read: () => Promise.resolve(node) },
    edges: { read: noEdgeRead },
    audit: { record: (event) => Promise.resolve(void events.push(event)) },
    references: keys,
    logger: { warn: () => undefined },
  });
  const principal = (await memoryAppStore().current()).principal;
  const token = makeToken(keys, { sourceId: 'demo', entityType: 'person' }, 'ID-1');
  return { events, result: service.open({ traceId: 'tr-1', principal, link: { form: 'entity', ref: { sourceId: 'demo', entityType: 'person', stableId: token } }, mask, headers: {} }) };
}

describe('the source link of a keyed type', () => {
  it('builds the address from the value read from the token when the gate returned the value', async () => {
    const token = makeToken(keys, { sourceId: 'demo', entityType: 'person' }, 'ID-1');
    const { result, events } = await open(nodeWith(token, false));
    expect(await result).toBe('https://records.example.test/p/ID-1');
    expect(events.map((event) => event.result)).toEqual(['success']);
  });

  it('refuses with NOT_FOUND, and audits refused, when the gate returned the stable ID masked although the request was not masked', async () => {
    const token = makeToken(keys, { sourceId: 'demo', entityType: 'person' }, 'ID-1');
    const { result, events } = await open(nodeWith(token, true));
    await expect(result).rejects.toEqual(new AppError('NOT_FOUND'));
    expect(events.map((event) => event.result)).toEqual(['refused']);
  });
});
