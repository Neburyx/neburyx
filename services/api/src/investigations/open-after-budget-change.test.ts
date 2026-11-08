import { rmSync } from 'node:fs';
import { investigationResponseSchema, openInvestigationResponseSchema } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { memoryAppStore } from '../testing/app-store.js';
import { entityRows, plainNode } from '../testing/entity-fixtures.js';
import { TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { withOnlineIndexes } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const mappingWith = (budgets: Record<string, number>) => parseMapping(
  fileOf(baseSource({ id: 'demo', budgets, entities: [{ type: 'widget', label: 'Widget', stable_id: 'widgetId' }, { type: 'gizmo', label: 'Gizmo', stable_id: 'gizmoId' }], relationships: [{ type: 'LINKS', from: 'widget', to: 'gizmo' }] })),
  'neburyx.yaml',
);

const before = mappingWith({});
const after = mappingWith({ breaker_failures: 2, breaker_cooldown_ms: 5000, requests_per_minute: 30 });

async function startedOn(mapping: typeof before, store: ReturnType<typeof memoryAppStore>) {
  const [source] = mapping.sources;
  if (source === undefined) throw new Error('the mapping has no source');
  const executor = new TestExecutor(withOnlineIndexes(source, () => Promise.resolve(entityRows(plainNode(['Widget'], { widgetId: 'W-1' })))));
  return buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store, mapping, gate: testSourceGate(mapping, { executor }).gate });
}

describe('an investigation saved before a budget of its source changed', () => {
  it('still opens, and is read, with the source available: only the source address and database decide, not the configuration hash', async () => {
    expect(after.sources[0]?.configHash).not.toBe(before.sources[0]?.configHash);
    const store = memoryAppStore();
    const first = await startedOn(before, store);
    const created = openInvestigationResponseSchema.parse((await first.inject({ method: 'POST', url: '/v1/investigations', payload: { sourceId: 'demo', entity: { sourceId: 'demo', entityType: 'widget', stableId: 'W-1' }, caseRef: 'CASE-1' } })).json());
    await first.close();
    const second = await startedOn(after, store);
    const read = await second.inject({ method: 'GET', url: `/v1/investigations/${created.investigation.id}` });
    expect(read.statusCode).toBe(200);
    expect(investigationResponseSchema.parse(read.json()).investigation).toMatchObject({ id: created.investigation.id, sourceState: 'available' });
    const reopened = await second.inject({ method: 'POST', url: '/v1/investigations', payload: { sourceId: 'demo', entity: { sourceId: 'demo', entityType: 'widget', stableId: 'W-1' }, caseRef: 'CASE-1' } });
    expect(reopened.statusCode).toBe(200);
    expect(openInvestigationResponseSchema.parse(reopened.json())).toMatchObject({ created: false, investigation: { id: created.investigation.id } });
    expect(store.investigations).toHaveLength(1);
    await second.close();
  });
});
