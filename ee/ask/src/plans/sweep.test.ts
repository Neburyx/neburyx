import type { ExtensionLogger } from '@neburyx/contracts';
import { describe, expect, it, vi } from 'vitest';
import { PLAN_SWEEP_BATCH, PLAN_SWEEP_SCHEDULE, PLAN_SWEEP_TASK, PlanStoreError } from './store.js';
import { PLAN_SWEEP_EVENT, PLAN_SWEEP_FAILED_EVENT, createPlanSweepTask } from './sweep.js';
import { createMemoryPlanStore } from '../testing/memory-plans.js';

const lines = () => {
  const out: { level: string; fields: Record<string, unknown> }[] = [];
  const logger: ExtensionLogger = { warn: (fields) => void out.push({ level: 'warn', fields }), info: (fields) => void out.push({ level: 'info', fields }) };
  return { out, logger };
};

describe('the task that sweeps plans', () => {
  it('is named, runs every five minutes on a minute the other tasks do not use, and clears at most 500 plans', () => {
    expect([PLAN_SWEEP_TASK, PLAN_SWEEP_SCHEDULE, PLAN_SWEEP_BATCH]).toEqual(['ask-sweep-plans', '*/5 * * * *', 500]);
    const task = createPlanSweepTask(createMemoryPlanStore(), () => undefined);
    expect([task.name, task.schedule]).toEqual([PLAN_SWEEP_TASK, PLAN_SWEEP_SCHEDULE]);
  });

  it('logs a failure by its code and stops nothing: the task does not throw', async () => {
    const plans = createMemoryPlanStore();
    plans.failNext('sweep');
    const { out, logger } = lines();
    await expect(createPlanSweepTask(plans, () => logger).run(undefined)).resolves.toBeUndefined();
    expect(out).toEqual([{ level: 'warn', fields: { event: PLAN_SWEEP_FAILED_EVENT, code: 'PLAN_STORE_FAILED' } }]);
  });

  it('logs only a fixed code for an error that is not the store’s own, never its text', async () => {
    const plans = createMemoryPlanStore();
    plans.sweep = async () => Promise.reject(new Error('password authentication failed for user "app"'));
    const { out, logger } = lines();
    await createPlanSweepTask(plans, () => logger).run(undefined);
    expect(JSON.stringify(out)).not.toContain('password');
    expect(out[0]?.fields).toEqual({ event: PLAN_SWEEP_FAILED_EVENT, code: 'PLAN_STORE_FAILED' });
    expect(new PlanStoreError().code).toBe('PLAN_STORE_FAILED');
  });

  it('works without a logger', async () => {
    await expect(createPlanSweepTask(createMemoryPlanStore(), () => undefined).run(undefined)).resolves.toBeUndefined();
  });

  it('clears the plans that expired unread and says how many, and a second run clears nothing more', async () => {
    const plans = createMemoryPlanStore();
    const search = await plans.insert({ userId: 'u', sourceId: 'demo', templateId: 'search', templateVersion: 1, params: { entityTypes: ['node_a'], text: 'ref 77' }, planningTraceId: 't' });
    await plans.insert({ userId: 'u', sourceId: 'demo', templateId: 'entity', templateVersion: 1, params: { ref: { entityType: 'node_a', stableId: 'a-1' } }, planningTraceId: 't' });
    plans.advance(16 * 60_000);
    const fresh = await plans.insert({ userId: 'u', sourceId: 'demo', templateId: 'search', templateVersion: 1, params: { entityTypes: ['node_a'], text: 'ref 88' }, planningTraceId: 't' });
    const { out, logger } = lines();
    const task = createPlanSweepTask(plans, () => logger);
    await task.run(undefined);
    await task.run(undefined);
    expect(out.map((line) => line.fields)).toEqual([{ event: PLAN_SWEEP_EVENT, cleared: 2 }, { event: PLAN_SWEEP_EVENT, cleared: 0 }]);
    expect(plans.plans.map((plan) => plan.state)).toEqual(['expired', 'expired', 'proposed']);
    expect(JSON.stringify(plans.plans.filter((plan) => plan.id === search.id))).not.toContain('ref 77');
    expect(plans.plans.find((plan) => plan.id === fresh.id)?.params).toEqual({ entityTypes: ['node_a'], text: 'ref 88' });
  });

  it('keeps the typed value out of the plan after a claim, a cancel and an edit, and gives the claim the value it had', async () => {
    const plans = createMemoryPlanStore();
    const make = () => plans.insert({ userId: 'u', sourceId: 'demo', templateId: 'search', templateVersion: 1, params: { entityTypes: ['node_a'], text: 'ref 77' }, planningTraceId: 't' });
    const claimed = await make();
    const claim = await plans.claim(claimed.id, 'u');
    expect(claim).toMatchObject({ status: 'claimed', plan: { params: { entityTypes: ['node_a'], text: 'ref 77' } } });
    const cancelled = await make();
    await plans.cancel(cancelled.id, 'u');
    const edited = await make();
    await plans.edit({ planId: edited.id, userId: 'u', templateId: 'search', templateVersion: 1, params: { entityTypes: ['node_a'], text: 'ref 99' } });
    const held = plans.plans.map((plan) => [plan.state, JSON.stringify(plan.params)]);
    expect(held).toEqual([['confirmed', '{"entityTypes":["node_a"]}'], ['cancelled', '{"entityTypes":["node_a"]}'], ['cancelled', '{"entityTypes":["node_a"]}'], ['proposed', '{"entityTypes":["node_a"],"text":"ref 99"}']]);
  });
});
