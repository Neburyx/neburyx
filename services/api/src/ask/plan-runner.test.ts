import { parseExtensionRefusal, type AskPlanRun } from '@neburyx/contracts';
import { describe, expect, it, vi } from 'vitest';
import { AppError, RequestCancelled } from '../errors.js';
import type { MappingModel } from '../mapping/model.js';
import { principalFixture } from '../testing/principal-fixture.js';
import { createAskPlanRunnerFactory, refusalOfError, type AskPlanRunnerServices } from './plan-runner.js';

const SOURCE = 'demo';
const mapping = { sources: [{ id: SOURCE, derived: [{ id: 'rule_one', ruleVersion: 3, from: 'node_a', to: 'node_a' }] }] } as unknown as MappingModel;
const REF = { entityType: 'node_a', stableId: 'a-1' };
const signal = new AbortController().signal;

/** Services that record how they were called and answer a marked result, so what the runner passes and what it returns can be read. */
function rig(overrides: Partial<Record<keyof Omit<AskPlanRunnerServices, 'mapping'>, unknown>> = {}) {
  const calls: { service: string; request: Record<string, unknown> }[] = [];
  const answering = (service: string, answer: unknown) =>
    vi.fn(async (request: Record<string, unknown>) => {
      calls.push({ service, request });
      return answer;
    });
  const services = {
    templateRuns: { run: overrides.templateRuns ?? answering('templateRuns', { status: 'ok', templateId: 'shared-attribute' }) },
    entities: { read: overrides.entities ?? answering('entities', { ref: { sourceId: SOURCE, ...REF } }) },
    degrees: { preview: overrides.degrees ?? answering('degrees', { total: { quality: 'exact', value: 2, scope: 'x' } }) },
    expansions: { expand: overrides.expansions ?? answering('expansions', { nodes: [], edges: [], pages: [] }) },
    derivedNeighbors: { derive: overrides.derivedNeighbors ?? answering('derivedNeighbors', { ref: { sourceId: SOURCE, ...REF }, results: [{ ruleId: 'rule_one', ruleVersion: 3, count: { quality: 'exact', value: 1, scope: 'derived:neighbors' }, nodes: [], edges: [], warnings: [] }, { ruleId: 'rule_two', ruleVersion: 1, count: { quality: 'exact', value: 5, scope: 'derived:neighbors' }, nodes: [], edges: [], warnings: [] }] }) },
    edges: { read: overrides.edges ?? answering('edges', { semantics: 'derived' }) },
    searching: { search: overrides.searching ?? answering('searching', { sourceId: SOURCE }) },
    mapping,
  } as unknown as AskPlanRunnerServices;
  const runnerFor = (scope = { sourceId: SOURCE, mask: true }) => createAskPlanRunnerFactory(services)({ principal: principalFixture, traceId: 'tr-1', signal })(scope);
  return { calls, runnerFor };
}

const refusedWith = async (run: Promise<AskPlanRun>) => {
  const answer = await run;
  if (answer.status !== 'refused') throw new Error('not refused');
  return answer.refusal;
};

describe('a run that the gate or the services refuse', () => {
  it.each([
    ['a budget', new AppError('QUERY_BUDGET_EXCEEDED', { maxPage: 25, maxHops: 2 }), { code: 'QUERY_BUDGET_EXCEEDED', maxPage: 25, maxHops: 2 }],
    ['a timeout', new AppError('QUERY_TIMEOUT', { timeoutMs: 20000 }), { code: 'QUERY_TIMEOUT', timeoutMs: 20000 }],
    ['a busy source', new AppError('SOURCE_BUSY'), { code: 'SOURCE_BUSY' }],
    ['a source that is down', new AppError('SOURCE_UNAVAILABLE', undefined, 'refused'), { code: 'SOURCE_UNAVAILABLE', reason: 'refused' }],
    ['a source that waits after repeated timeouts', new AppError('SOURCE_UNAVAILABLE', { retryAfterMs: 5000 }, 'repeated-timeouts'), { code: 'SOURCE_UNAVAILABLE', reason: 'repeated-timeouts', retryAfterMs: 5000 }],
    ['a rate limit', new AppError('RATE_LIMITED', { retryAfterMs: 1000 }), { code: 'RATE_LIMITED', retryAfterMs: 1000 }],
    ['a source the caller lost access to', new AppError('ACCESS_DENIED', { reason: 'access-changed' }), { code: 'ACCESS_DENIED' }],
    ['a source the caller cannot read', new AppError('NOT_FOUND'), { code: 'NOT_FOUND' }],
    ['an audit that could not be written', new AppError('AUDIT_UNAVAILABLE'), { code: 'AUDIT_UNAVAILABLE' }],
    ['parameters the service refuses', new AppError('INVALID_REQUEST'), { code: 'ASK_PLAN_INVALID' }],
  ])('comes back as the refusal of %s, with the code and details the manual route gives and no result', async (_name, error, refusal) => {
    const { runnerFor } = rig({ entities: vi.fn(async () => Promise.reject(error)) });
    expect(await refusedWith(runnerFor().run({ templateId: 'entity', params: { ref: REF } }))).toEqual(refusal);
  });

  it('gives only refusals the mount can answer', () => {
    for (const code of ['QUERY_BUDGET_EXCEEDED', 'QUERY_TIMEOUT', 'SOURCE_BUSY', 'SOURCE_UNAVAILABLE', 'RATE_LIMITED', 'ACCESS_DENIED', 'NOT_FOUND', 'AUDIT_UNAVAILABLE'] as const) {
      const refusal = refusalOfError(new AppError(code, code === 'QUERY_TIMEOUT' ? { timeoutMs: 5 } : undefined));
      expect(parseExtensionRefusal({ name: 'ExtensionRefusal', ...refusal })).toEqual(refusal);
    }
  });

  it.each([
    ['an error that is not the application’s', new Error('relation does not exist')],
    ['a request the client gave up', new RequestCancelled()],
    ['an internal error', new AppError('INTERNAL_ERROR')],
    ['an error of the service that has no refusal', new AppError('CURSOR_INVALIDATED')],
  ])('throws %s instead of turning it into a refusal', async (_name, error) => {
    const { runnerFor } = rig({ entities: vi.fn(async () => Promise.reject(error)) });
    await expect(runnerFor().run({ templateId: 'entity', params: { ref: REF } })).rejects.toBe(error);
  });

  it.each([
    ['shared-attribute', { ref: REF, limit: 0 }],
    ['linked-entities', { nothing: true }],
    ['entity', { ref: { entityType: 'node_a' } }],
    ['degree-preview', 'a-1'],
    ['expand', { ref: REF }],
    ['derived-rule-run', { ref: REF }],
    ['derived-edge-support', { ruleId: 'rule_one', ends: [REF] }],
    ['search', { entityTypes: ['node_a'] }],
  ] as const)('refuses the parameters of a plan of %s that are not the template’s as an invalid plan, and reads nothing', async (templateId, params) => {
    const { runnerFor, calls } = rig();
    expect(await refusedWith(runnerFor().run({ templateId, params }))).toEqual({ code: 'ASK_PLAN_INVALID' });
    expect(calls).toEqual([]);
  });

  it('refuses a rule the mapping does not hold as an invalid plan, and reads nothing', async () => {
    const { runnerFor, calls } = rig();
    expect(await refusedWith(runnerFor().run({ templateId: 'derived-rule-run', params: { ref: REF, ruleId: 'rule_missing' } }))).toEqual({ code: 'ASK_PLAN_INVALID' });
    expect(calls).toEqual([]);
  });
});

describe('what a run is bound to', () => {
  it.each([
    ['shared-attribute', { ref: REF, limit: 5 }, 'templateRuns'],
    ['entity', { ref: REF }, 'entities'],
    ['degree-preview', { ref: REF }, 'degrees'],
    ['expand', { ref: REF, neighborTypes: ['node_b'] }, 'expansions'],
    ['derived-rule-run', { ref: REF, ruleId: 'rule_one' }, 'derivedNeighbors'],
    ['derived-edge-support', { ruleId: 'rule_one', ends: [REF, { entityType: 'node_a', stableId: 'a-2' }] }, 'edges'],
    ['search', { entityTypes: ['node_a'], text: 'ref 77' }, 'searching'],
  ] as const)('reads a plan of %s as the caller, on the source of the scope, with the trace, the mask and the abort signal of the request', async (templateId, params, service) => {
    const { runnerFor, calls } = rig();
    await runnerFor({ sourceId: SOURCE, mask: false }).run({ templateId, params });
    expect(calls.map((call) => call.service)).toEqual([service]);
    expect(calls[0]?.request).toMatchObject({ traceId: 'tr-1', principal: principalFixture, mask: false, signal, ...(templateId === 'derived-edge-support' ? {} : { sourceId: SOURCE }) });
  });

  it('names no source of its own: the source of the call is the scope’s whatever the parameters say', async () => {
    const { runnerFor, calls } = rig();
    await runnerFor({ sourceId: 'other', mask: true }).run({ templateId: 'entity', params: { ref: REF } });
    expect(calls[0]?.request['sourceId']).toBe('other');
  });
});

describe('the run of each template', () => {
  it('runs shared-attribute and linked-entities by the template run service, by their own IDs, and never as a continuation', async () => {
    const { runnerFor, calls } = rig();
    await runnerFor().run({ templateId: 'shared-attribute', params: { ref: REF, attributeType: 'attr_type', via: 'link_a', limit: 5 } });
    await runnerFor().run({ templateId: 'linked-entities', params: { ref: REF, targetType: 'node_b', maxHops: 2 } });
    expect(calls.map((call) => [call.request['id'], call.request['continue']])).toEqual([['shared-attribute', false], ['linked-entities', false]]);
    expect(calls[0]?.request['params']).toEqual({ ref: REF, attributeType: 'attr_type', via: 'link_a', limit: 5 });
  });

  it('answers each result with the template ID it came from', async () => {
    const { runnerFor } = rig();
    const answer = await runnerFor().run({ templateId: 'entity', params: { ref: REF } });
    expect(answer).toEqual({ status: 'ok', result: { templateId: 'entity', result: { ref: { sourceId: SOURCE, ...REF } } } });
  });

  it('reads an entity as one request of the caller, as its manual route does', async () => {
    const { runnerFor, calls } = rig();
    await runnerFor().run({ templateId: 'entity', params: { ref: REF } });
    expect(calls[0]?.request).toMatchObject({ entityType: 'node_a', stableId: 'a-1', rate: 'count' });
  });

  it('expands with both directions unless the plan names one, and passes the types, the window and the limit', async () => {
    const { runnerFor, calls } = rig();
    await runnerFor().run({ templateId: 'expand', params: { ref: REF, neighborTypes: ['node_b'], relTypes: ['link_a'], window: { days: 30 }, limit: 10 } });
    await runnerFor().run({ templateId: 'expand', params: { ref: REF, neighborTypes: ['node_b'], direction: 'out' } });
    expect(calls[0]?.request).toMatchObject({ entityType: 'node_a', stableId: 'a-1', neighborTypes: ['node_b'], relTypes: ['link_a'], direction: 'both', window: { days: 30 }, limit: 10 });
    expect(calls[1]?.request).toMatchObject({ direction: 'out' });
    expect(calls[1]?.request).not.toHaveProperty('relTypes');
  });

  it('keeps only the rule of the plan from the derived neighbors of the entity', async () => {
    const { runnerFor } = rig();
    const answer = await runnerFor().run({ templateId: 'derived-rule-run', params: { ref: REF, ruleId: 'rule_one' } });
    expect(answer).toMatchObject({ status: 'ok', result: { templateId: 'derived-rule-run', result: { results: [{ ruleId: 'rule_one', count: { value: 1 } }] } } });
    expect(JSON.stringify(answer)).not.toContain('rule_two');
  });

  it('answers a rule that gives nothing for the entity with an empty result with an exact count of 0, not an error', async () => {
    const { runnerFor } = rig({ derivedNeighbors: vi.fn(async () => ({ ref: { sourceId: SOURCE, ...REF }, results: [] })) });
    const answer = await runnerFor().run({ templateId: 'derived-rule-run', params: { ref: REF, ruleId: 'rule_one' } });
    expect(answer).toEqual({ status: 'ok', result: { templateId: 'derived-rule-run', result: { ref: { sourceId: SOURCE, ...REF }, results: [{ ruleId: 'rule_one', ruleVersion: 3, count: { quality: 'exact', value: 0, scope: 'derived:neighbors' }, nodes: [], edges: [], warnings: [] }] } } });
  });

  it('reads the support of a derived edge by the edge reader with both ends of the plan in the source of the scope', async () => {
    const { runnerFor, calls } = rig();
    await runnerFor().run({ templateId: 'derived-edge-support', params: { ruleId: 'rule_one', ends: [REF, { entityType: 'node_a', stableId: 'a-2' }] } });
    expect(calls[0]?.request).toMatchObject({ ref: { sourceId: SOURCE, derived: { ruleId: 'rule_one', from: { sourceId: SOURCE, ...REF }, to: { sourceId: SOURCE, entityType: 'node_a', stableId: 'a-2' } } }, rate: 'count' });
  });

  it('searches the types of the plan for its text as a parameter of the search, nothing else', async () => {
    const { runnerFor, calls } = rig();
    await runnerFor().run({ templateId: 'search', params: { entityTypes: ['node_a', 'node_b'], text: 'ref 77' } });
    expect(calls[0]?.request).toMatchObject({ text: 'ref 77', entityTypes: ['node_a', 'node_b'] });
  });
});
