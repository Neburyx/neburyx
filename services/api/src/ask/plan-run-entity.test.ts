import { rmSync } from 'node:fs';
import { askRunResponseSchema, nodeSchema, type AskPlanner } from '@neburyx/contracts';
import { createEnterpriseExtension } from '@neburyx/ee-ask';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { communitySeams } from '../seams/community-seams.js';
import type { AuditEvent, Seams } from '../seams/seams.js';
import { memoryAppStore } from '../testing/app-store.js';
import { entityRows, plainNode } from '../testing/entity-fixtures.js';
import { TestExecutor } from '../testing/gate.js';
import { createListPlanStore } from '../testing/list-plan-store.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { principalFixture } from '../testing/principal-fixture.js';
import { withOnlineIndexes } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';

vi.mock('@neburyx/ee-audit', () => ({ createAuditSink: () => ({ sink: { record: () => Promise.resolve() }, close: async () => undefined }) }));

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const available: AskPlanner = { availability: () => ({ available: true }), plan: () => Promise.reject(new Error('not used')) };
const mapping = parseMapping(fileOf(baseSource({ id: 'demo', entities: [{ type: 'widget', label: 'Widget', stable_id: 'widgetId', title: 'Widget {widgetId}', display: { key_properties: ['status'] }, pii: [{ property: 'ownerName', class: 'name' }] }], relationships: [] })), 'neburyx.yaml');
const ACCOUNT = plainNode(['Widget'], { widgetId: 'AC-1', status: 'open', ownerName: 'Ana Silva' });

async function started() {
  const [source] = mapping.sources;
  if (source === undefined) throw new Error('the mapping has no source');
  const executor = new TestExecutor(withOnlineIndexes(source, () => Promise.resolve(entityRows(ACCOUNT))));
  const events: AuditEvent[] = [];
  const defaults = communitySeams();
  const seams: Pick<Seams, 'policy' | 'coordinator' | 'audit'> = { policy: defaults.policy, coordinator: defaults.coordinator, audit: { record: (event) => (events.push(event), Promise.resolve()) } };
  const parts = testSourceGate(mapping, { executor, seams });
  const plans = createListPlanStore();
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping, gate: parts.gate, seams: { ...seams, askPlanner: available } as Seams, extension: createEnterpriseExtension({ planStore: plans }), previewOn: true });
  return { app, plans, events };
}

describe('the run of an entity plan through the gate', () => {
  it('answers the same node as the manual entity route, masked as asked, and writes the entity read event of the gate', async () => {
    const rig = await started();
    const manual = nodeSchema.parse((await rig.app.inject({ method: 'GET', url: '/v1/entities/demo/widget/AC-1?mask=true' })).json());
    const plan = rig.plans.put({ userId: principalFixture.id, templateId: 'entity', params: { ref: { entityType: 'widget', stableId: 'AC-1' } } });
    const response = await rig.app.inject({ method: 'POST', url: '/v1/ask/run', payload: { planId: plan.id, mask: true } });
    expect(response.statusCode).toBe(200);
    expect(askRunResponseSchema.parse(response.json())).toMatchObject({ outcome: 'complete', result: { templateId: 'entity', result: manual } });
    expect(rig.plans.runs).toEqual([expect.objectContaining({ outcome: 'complete', rowCount: 1 })]);
    expect(rig.events.length).toBeGreaterThanOrEqual(2);
    await rig.app.close();
  });

  it('answers an invalid plan, where the manual route answers INVALID_REQUEST, for an entity type the source does not map, with a failed run', async () => {
    const rig = await started();
    expect((await rig.app.inject({ method: 'GET', url: '/v1/entities/demo/nothing/AC-1' })).json().error.code).toBe('INVALID_REQUEST');
    const plan = rig.plans.put({ userId: principalFixture.id, templateId: 'entity', params: { ref: { entityType: 'nothing', stableId: 'AC-1' } } });
    const response = await rig.app.inject({ method: 'POST', url: '/v1/ask/run', payload: { planId: plan.id } });
    expect([response.statusCode, response.json().error.code]).toEqual([422, 'ASK_PLAN_INVALID']);
    expect(rig.plans.runs[0]).toMatchObject({ outcome: 'failed' });
    await rig.app.close();
  });
});
