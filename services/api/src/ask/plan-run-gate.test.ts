import { rmSync } from 'node:fs';
import { askRunResponseSchema, expandResponseSchema, searchResultSchema, type AskPlanner } from '@neburyx/contracts';
import { createEnterpriseExtension } from '@neburyx/ee-ask';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { EXPAND_NEIGHBORS_ID } from '../gate/templates/expand-neighbors.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { communitySeams } from '../seams/community-seams.js';
import type { Seams } from '../seams/seams.js';
import { memoryAppStore } from '../testing/app-store.js';
import { entityRows } from '../testing/entity-fixtures.js';
import { TestExecutor } from '../testing/gate.js';
import { createListPlanStore } from '../testing/list-plan-store.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { plainNode, plainRelationship } from '../testing/normalize-fixtures.js';
import { principalFixture } from '../testing/principal-fixture.js';
import { onlineIndexesOf, schemaAnswer, withSchema } from '../testing/search-fixtures.js';
import { startSearchApp, widgets } from '../testing/search-app.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';

vi.mock('@neburyx/ee-audit', () => ({ createAuditSink: () => ({ sink: { record: () => Promise.resolve() }, close: async () => undefined }) }));

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const available: AskPlanner = { availability: () => ({ available: true }), plan: () => Promise.reject(new Error('not used')) };

describe('the run of a search plan through the gate', () => {
  async function searching() {
    const plans = createListPlanStore();
    const rig = await startSearchApp({ rows: widgets(30), appOptions: { extension: createEnterpriseExtension({ planStore: plans }), previewOn: true, seams: { ...communitySeams(), askPlanner: available } as Seams } });
    return { ...rig, plans };
  }

  it('answers the hits and counts the manual search gives for the text and types of the plan, and the typed text reaches the adapter only as the bound search value', async () => {
    const rig = await searching();
    const manual = searchResultSchema.parse((await rig.app.inject({ method: 'POST', url: '/v1/search/entities', payload: { sourceId: 'demo', text: 'W-0', entityTypes: ['widget'] } })).json());
    const before = rig.executor.calls.length;
    const plan = rig.plans.put({ userId: principalFixture.id, templateId: 'search', params: { entityTypes: ['widget'], text: 'W-0' } });
    const response = await rig.app.inject({ method: 'POST', url: '/v1/ask/run', payload: { planId: plan.id } });
    expect(response.statusCode).toBe(200);
    const answer = askRunResponseSchema.parse(response.json());
    if (answer.result.templateId !== 'search') throw new Error('not a search result');
    expect({ ...answer.result.result, elapsedMs: 0 }).toEqual({ ...manual, elapsedMs: 0 });
    expect(answer.result.result.exact).toHaveLength(25);
    expect(answer.outcome).toBe('partial');
    expect(rig.plans.runs[0]).toMatchObject({ outcome: 'partial' });
    const calls = rig.executor.calls.slice(before);
    expect(calls.some((call) => JSON.stringify(call.parameters).includes('W-0'))).toBe(true);
    for (const call of calls) {
      const { parameters: _bound, ...rest } = call;
      expect(JSON.stringify(rest)).not.toContain('W-0');
    }
    await rig.app.close();
  });
});

describe('the run of an expand plan through the gate', () => {
  const mapping = parseMapping(
    fileOf(
      baseSource({
        id: 'demo',
        entities: [
          { type: 'hub', label: 'Hub', stable_id: 'hubId' },
          { type: 'leaf', label: 'Leaf', stable_id: 'leafId' },
        ],
        relationships: [{ type: 'LINKED', from: 'hub', to: 'leaf', stable_id: 'relId', observed_at: 'seenAt' }],
      }),
    ),
    'neburyx.yaml',
  );
  const hub = plainNode(['Hub'], { hubId: 'H-1' }, 'e-hub');
  const leaf = (id: string) => plainNode(['Leaf'], { leafId: id }, `e-${id}`);
  const rowsOf = (count: number) => Array.from({ length: count }, (_, index) => ({ a: hub, m: leaf(`l${index}`), rel: plainRelationship('LINKED', hub, leaf(`l${index}`), { relId: `r${index}` }, `rel-${index}`), phase: 2, ts: null, id: `r${index}`, rtype: 'LINKED', dir: 'out', ntype: null, flag: null, members: null, first: null }));

  async function expanding(count: number) {
    const [source] = mapping.sources;
    if (source === undefined) throw new Error('the mapping has no source');
    const answer = (call: ExecuteCall): Promise<ExecuteOutcome> => Promise.resolve(call.templateId === 'entity-load' ? entityRows(plainNode(['Hub'], { hubId: 'H-1' })) : { status: 'rows', rows: rowsOf(count) });
    const executor = new TestExecutor(withSchema(() => schemaAnswer(onlineIndexesOf(source)), answer));
    const defaults = communitySeams();
    const seams: Pick<Seams, 'policy' | 'coordinator' | 'audit'> = { policy: defaults.policy, coordinator: defaults.coordinator, audit: { record: () => Promise.resolve() } };
    const parts = testSourceGate(mapping, { executor, seams });
    const plans = createListPlanStore();
    const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping, gate: parts.gate, seams: { ...seams, askPlanner: available } as Seams, extension: createEnterpriseExtension({ planStore: plans }), previewOn: true });
    return { app, executor, plans };
  }
  const REF = { entityType: 'hub', stableId: 'H-1' };
  const planOf = (rig: Awaited<ReturnType<typeof expanding>>, params: object) => rig.plans.put({ userId: principalFixture.id, templateId: 'expand', params: { ref: REF, neighborTypes: ['leaf'], ...params } });

  it('answers the nodes and pages the manual expansion gives for the same parameters, partial when a page has more', async () => {
    const rig = await expanding(3);
    const manual = expandResponseSchema.parse((await rig.app.inject({ method: 'POST', url: '/v1/graph/expand', payload: { sourceId: 'demo', ref: REF, neighborTypes: ['leaf'], limit: 2 } })).json());
    const plan = planOf(rig, { limit: 2 });
    const response = await rig.app.inject({ method: 'POST', url: '/v1/ask/run', payload: { planId: plan.id } });
    expect(response.statusCode).toBe(200);
    const answer = askRunResponseSchema.parse(response.json());
    expect(answer.result).toEqual({ templateId: 'expand', result: manual });
    expect(manual.pages[0]).toMatchObject({ returned: 2, hasMore: true });
    expect(answer.outcome).toBe('partial');
    expect(rig.plans.runs[0]).toMatchObject({ outcome: 'partial', rowCount: manual.nodes.length });
    await rig.app.close();
  });

  it('says complete when no page has more', async () => {
    const rig = await expanding(2);
    const plan = planOf(rig, { limit: 5 });
    const answer = askRunResponseSchema.parse((await rig.app.inject({ method: 'POST', url: '/v1/ask/run', payload: { planId: plan.id } })).json());
    expect(answer.outcome).toBe('complete');
    await rig.app.close();
  });

  it('answers QUERY_BUDGET_EXCEEDED, as the manual route does, for a limit over the max_page of the source, reads nothing and records a failed run', async () => {
    const rig = await expanding(3);
    const plan = planOf(rig, { limit: 51 });
    const response = await rig.app.inject({ method: 'POST', url: '/v1/ask/run', payload: { planId: plan.id } });
    expect([response.statusCode, response.json().error.code]).toEqual([422, 'QUERY_BUDGET_EXCEEDED']);
    expect(rig.executor.calls.filter((call) => call.templateId === EXPAND_NEIGHBORS_ID)).toHaveLength(0);
    expect(rig.plans.runs[0]).toMatchObject({ outcome: 'failed' });
    await rig.app.close();
  });
});
