import { rmSync } from 'node:fs';
import { searchResultSchema } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { EXPAND_NEIGHBORS_ID } from '../gate/templates/expand-neighbors.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { communitySeams } from '../seams/community-seams.js';
import type { ReadAccessRequest } from '../seams/seams.js';
import { memoryAppStore } from '../testing/app-store.js';
import { entityRows } from '../testing/entity-fixtures.js';
import { plainNode, plainRelationship } from '../testing/normalize-fixtures.js';
import { TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { RELATED_ENTITIES, postSearch, searchMappingOf, startSearchApp } from '../testing/search-app.js';
import { searchModelOf, withOnlineIndexes, type StoredNode, type StoredRelationship } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

/** One user slot and one source slot: a read that asked for a lease while its request held one would wait for itself and answer SOURCE_BUSY. */
const ONE_AND_ONE = { user_concurrency: 1, source_concurrency: 1, queue_wait_ms: 500 };

describe('with one user slot and one source slot and the real slots', () => {
  it('answers a search of every group and the facet read, then a type-ahead search, with no group failed', async () => {
    const widget: StoredNode = { elementId: '4:s:1', label: 'Widget', properties: { widgetId: 'W-1', batchRef: 'BT-0' } };
    const gadget: StoredNode = { elementId: '4:s:2', label: 'Gadget', properties: { gadgetId: 'GT-1' } };
    const link: StoredRelationship = { elementId: '5:r:1', type: 'MADE_FROM', from: widget, to: gadget, properties: { linkId: 'L-1', recordId: 'W-1' } };
    const mapping = searchMappingOf({ entities: RELATED_ENTITIES, relationships: [{ type: 'MADE_FROM', from: 'widget', to: 'gadget', stable_id: 'linkId', evidence: ['recordId'] }], budgets: ONE_AND_ONE });
    const { app, executor } = await startSearchApp({ mapping, respond: searchModelOf([widget, gadget], () => undefined, [link]) });
    const full = await postSearch(app, { sourceId: 'demo', text: 'W-1' });
    expect(full.statusCode).toBe(200);
    expect(searchResultSchema.parse(full.json()).failures).toEqual([]);
    expect(executor.calls.map((call) => call.templateId).sort()).toEqual(['entity-related', 'entity-search', 'relationship-evidence', 'schema-indexes', 'search-facets']);
    const typeahead = await postSearch(app, { sourceId: 'demo', text: 'W-1', typeahead: true });
    expect(typeahead.statusCode).toBe(200);
    expect(searchResultSchema.parse(typeahead.json()).failures).toEqual([]);
    await app.close();
  });

  it('answers an entity load, a degree preview and an expansion of three neighbor types', async () => {
    const mapping = parseMapping(
      fileOf(
        baseSource({
          id: 'demo',
          budgets: ONE_AND_ONE,
          entities: [
            { type: 'hub', label: 'Hub', stable_id: 'hubId' },
            { type: 'leaf', label: 'Leaf', stable_id: 'leafId' },
            { type: 'other', label: 'Other', stable_id: 'otherId' },
          ],
          relationships: [
            { type: 'LINKED', from: 'hub', to: 'leaf', stable_id: 'relId' },
            { type: 'MET', from: 'hub', to: 'other', stable_id: 'metId' },
            { type: 'LOOPS', from: 'hub', to: 'hub', stable_id: 'loopId' },
          ],
        }),
      ),
      'neburyx.yaml',
    );
    const [source] = mapping.sources;
    if (source === undefined) throw new Error('the mapping has no source');
    const hub = plainNode(['Hub'], { hubId: 'H-1' }, 'e-hub');
    const leaf = plainNode(['Leaf'], { leafId: 'L-1' }, 'e-leaf');
    const respond = (call: ExecuteCall): Promise<ExecuteOutcome> => {
      if (call.templateId === 'entity-load') return Promise.resolve(entityRows(hub));
      if (call.templateId === EXPAND_NEIGHBORS_ID) {
        return Promise.resolve({ status: 'rows', rows: [{ a: hub, m: leaf, rel: plainRelationship('LINKED', hub, leaf, { relId: 'r1' }, 'rel-1'), phase: 2, ts: null, id: 'r1', rtype: 'LINKED', dir: 'out', ntype: null, flag: null, members: null, first: null }] });
      }
      const columns = new Set(call.cypher.match(/\bc\d+\b/g) ?? []);
      return Promise.resolve({ status: 'rows', rows: [Object.fromEntries([...columns].map((name) => [name, 1]))] });
    };
    const executor = new TestExecutor(withOnlineIndexes(source, respond));
    const defaults = communitySeams();
    const requests: ReadAccessRequest[] = [];
    const coordinator = { acquireRead: (request: ReadAccessRequest) => (requests.push(request), defaults.coordinator.acquireRead(request)) };
    const seams = { policy: defaults.policy, coordinator, audit: defaults.audit };
    const parts = testSourceGate(mapping, { executor, seams });
    const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping, gate: parts.gate, seams, indexes: parts.indexes });
    const entity = await app.inject({ method: 'GET', url: '/v1/entities/demo/hub/H-1' });
    expect(entity.statusCode).toBe(200);
    const preview = await app.inject({ method: 'POST', url: '/v1/graph/preview-expansion', payload: { sourceId: 'demo', ref: { entityType: 'hub', stableId: 'H-1' } } });
    expect(preview.statusCode).toBe(200);
    const expansion = await app.inject({ method: 'POST', url: '/v1/graph/expand', payload: { sourceId: 'demo', ref: { entityType: 'hub', stableId: 'H-1' }, neighborTypes: ['leaf', 'other', 'hub'] } });
    expect(expansion.statusCode).toBe(200);
    expect(requests.every((request) => request.limits.userConcurrency === 1 && request.limits.sourceConcurrency === 1)).toBe(true);
    await app.close();
  });
});
