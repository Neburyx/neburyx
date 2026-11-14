import { askEditResponseSchema, parseExtensionRefusal, type AiMappingView, type AskPatternOffer, type AskPlanner, type ExtensionRequest } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { createMemoryPlanStore } from '../testing/memory-plans.js';
import { ASK_EDIT_URL, createAskEditRoute } from './ask-edit.js';

const VIEW: AiMappingView = { types: [{ name: 'node_a', kind: 'entity', properties: [] }, { name: 'node_b', kind: 'entity', properties: [] }, { name: 'link_a', kind: 'relationship', properties: [] }], derivedRules: [{ id: 'rule_one', from: 'node_a', to: 'node_a' }] };
const available: AskPlanner = { availability: () => ({ available: true }), plan: () => Promise.reject(new Error('not used')) };
const request = (body: unknown, over: Partial<ExtensionRequest> = {}): ExtensionRequest => ({ principalId: 'u-1', principalRole: 'investigator', previewOn: true, traceId: 'tr-1', audit: { record: async () => undefined }, askPlanner: available, body, ...over });
const ref = (stableId: string, sourceId = 'demo', entityType = 'node_a') => ({ sourceId, entityType, stableId });

async function setup() {
  const plans = createMemoryPlanStore();
  const stored = await plans.insert({ userId: 'u-1', sourceId: 'demo', templateId: 'entity', templateVersion: 1, params: { ref: { entityType: 'node_a', stableId: 'a-1' } }, planningTraceId: 'tr-0' });
  const route = createAskEditRoute({ plans: () => plans, view: () => VIEW });
  const edit = (body: object, over?: Partial<ExtensionRequest>) => route.handler(request({ planId: stored.id, templateId: 'entity', params: { ref: ref('a-2') }, ...body }, over));
  const refusal = async (promise: Promise<unknown>) => parseExtensionRefusal(await promise.catch((error: unknown) => error));
  return { plans, stored, route, edit, refusal };
}

describe('the edit route', () => {
  it('is a POST route of its own with a request and an answer schema', () => {
    const route = createAskEditRoute();
    expect([route.method, route.url, route.permission, route.requestSchema === undefined, route.responseSchema === undefined]).toEqual(['POST', ASK_EDIT_URL, 'principal', false, false]);
    expect(ASK_EDIT_URL).toBe('/v1/ask/edit');
  });

  it('refuses with ASK_UNSUPPORTED when the planner is not available, and when there is no store, and touches nothing', async () => {
    const { plans, stored, edit, refusal } = await setup();
    const none: AskPlanner = { availability: () => ({ available: false, reason: 'x' }), plan: () => Promise.reject(new Error('no')) };
    expect(await refusal(edit({}, { askPlanner: none }))).toEqual({ code: 'ASK_UNSUPPORTED', reason: 'not-in-this-edition' });
    expect(await refusal(createAskEditRoute({ view: () => VIEW }).handler(request({ planId: stored.id, templateId: 'entity', params: { ref: ref('a-2') } })))).toEqual({ code: 'ASK_UNSUPPORTED', reason: 'not-in-this-edition' });
    expect(plans.plans.map((plan) => plan.state)).toEqual(['proposed']);
  });

  it.each([
    ['another user’s plan', { planId: '' }],
  ])('answers NOT_FOUND for a plan that is not there, and for %s', async (_name) => {
    const { plans, stored, edit, refusal } = await setup();
    expect(await refusal(edit({ planId: '01939999-0000-7000-8000-0000000000ff' }))).toEqual({ code: 'NOT_FOUND' });
    expect(await refusal(edit({}, { principalId: 'u-2' }))).toEqual({ code: 'NOT_FOUND' });
    expect(plans.plans).toEqual([stored]);
  });

  it('answers CONFLICT plan-expired for an expired plan, and plan-not-runnable for a cancelled, claimed or run one, and changes nothing', async () => {
    const { plans, stored, edit, refusal } = await setup();
    plans.advance(16 * 60_000);
    expect(await refusal(edit({}))).toEqual({ code: 'CONFLICT', reason: 'plan-expired' });
    for (const prepare of [(id: string) => plans.cancel(id, 'u-1'), (id: string) => plans.claim(id, 'u-1')]) {
      const fresh = await plans.insert({ userId: 'u-1', sourceId: 'demo', templateId: 'entity', templateVersion: 1, params: {}, planningTraceId: 'tr-0' });
      await prepare(fresh.id);
      expect(await refusal(edit({ planId: fresh.id }))).toEqual({ code: 'CONFLICT', reason: 'plan-not-runnable' });
    }
    expect(plans.plans.filter((plan) => plan.parentPlanId === stored.id)).toEqual([]);
  });

  it('refuses a plan that expired between the read and the edit as the store tells it, and writes no new plan', async () => {
    const { plans, stored, edit, refusal } = await setup();
    const real = plans.edit;
    plans.edit = async (change) => (plans.advance(16 * 60_000), real(change));
    expect(await refusal(edit({}))).toEqual({ code: 'CONFLICT', reason: 'plan-expired' });
    expect(plans.plans.filter((plan) => plan.parentPlanId === stored.id)).toEqual([]);
  });

  it.each([
    ['another template', { templateId: 'degree-preview' }],
    ['a type the mapping does not hold', { params: { ref: ref('a-2', 'demo', 'node_z') } }],
    ['no source on the reference', { params: { ref: { entityType: 'node_a', stableId: 'a-2' } } }],
    ['a field the template does not name', { params: { ref: ref('a-2'), query: 'MATCH (n) RETURN n' } }],
    ['no reference', { params: {} }],
  ])('answers ASK_PLAN_INVALID for %s and changes nothing', async (_name, body) => {
    const { plans, stored, edit, refusal } = await setup();
    expect(await refusal(edit(body))).toEqual({ code: 'ASK_PLAN_INVALID' });
    expect(plans.plans).toEqual([stored]);
  });

  it('answers SOURCE_MISMATCH for a reference of another source than the plan’s, and changes nothing', async () => {
    const { plans, stored, edit, refusal } = await setup();
    expect(await refusal(edit({ params: { ref: ref('a-2', 'elsewhere') } }))).toEqual({ code: 'SOURCE_MISMATCH' });
    expect(plans.plans).toEqual([stored]);
  });

  it('checks the mapping for the types and rules of the other templates', async () => {
    const plans = createMemoryPlanStore();
    const expandPlan = await plans.insert({ userId: 'u-1', sourceId: 'demo', templateId: 'expand', templateVersion: 1, params: {}, planningTraceId: 'tr-0' });
    const route = createAskEditRoute({ plans: () => plans, view: () => VIEW });
    const edit = (params: object) => route.handler(request({ planId: expandPlan.id, templateId: 'expand', params }));
    const refusal = async (promise: Promise<unknown>) => parseExtensionRefusal(await promise.catch((error: unknown) => error));
    expect(await refusal(edit({ ref: ref('a-1'), neighborTypes: ['node_z'] }))).toEqual({ code: 'ASK_PLAN_INVALID' });
    expect(await refusal(edit({ ref: ref('a-1'), neighborTypes: ['node_b'], relTypes: ['link_z'] }))).toEqual({ code: 'ASK_PLAN_INVALID' });
    expect(await edit({ ref: ref('a-1'), neighborTypes: ['node_b'], relTypes: ['link_a'] })).toMatchObject({ plan: { templateId: 'expand' } });
  });

  it('refuses every edit when the application has no view of the mapping, since no type can be checked', async () => {
    const plans = createMemoryPlanStore();
    const stored = await plans.insert({ userId: 'u-1', sourceId: 'demo', templateId: 'entity', templateVersion: 1, params: {}, planningTraceId: 'tr-0' });
    const refusal = parseExtensionRefusal(await createAskEditRoute({ plans: () => plans }).handler(request({ planId: stored.id, templateId: 'entity', params: { ref: ref('a-2') } })).catch((error: unknown) => error));
    expect(refusal).toEqual({ code: 'ASK_PLAN_INVALID' });
  });

  it('stores the new plan with the old as its parent and the same source, owner and planning trace, cancels the old one and answers the new plan with its ID and expiry', async () => {
    const { plans, stored, edit } = await setup();
    plans.advance(60_000);
    const answer = askEditResponseSchema.parse(await edit({ params: { ref: ref('a-2') } }));
    const [old, fresh] = plans.plans;
    expect(old).toMatchObject({ id: stored.id, state: 'cancelled' });
    expect(fresh).toMatchObject({ parentPlanId: stored.id, state: 'proposed', sourceId: 'demo', userId: 'u-1', planningTraceId: 'tr-0', templateId: 'entity', params: { ref: { entityType: 'node_a', stableId: 'a-2' } } });
    expect(answer).toMatchObject({ planId: fresh?.id, expiresAt: fresh?.expiresAt.toISOString(), plan: { templateId: 'entity', params: { ref: { entityType: 'node_a', stableId: 'a-2' } } } });
    expect(fresh?.expiresAt.getTime()).toBeGreaterThan(stored.expiresAt.getTime());
    expect(JSON.stringify(plans.plans)).not.toContain('sourceId":"demo","entityType');
  });

  it('answers a store failure as a failure, not a refusal, and leaves the plan as it was', async () => {
    const { plans, stored, edit } = await setup();
    plans.failNext('edit');
    const failure = await edit({}).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'PLAN_STORE_FAILED' });
    expect(parseExtensionRefusal(failure)).toBeUndefined();
    expect(plans.plans).toEqual([stored]);
  });
});

describe('editing a plan that names a saved pattern', () => {
  const PATTERN = '0195a000-0000-7000-8000-000000000001';
  const OFFER: AskPatternOffer = { id: PATTERN, version: 3, name: 'A pattern', projection: { kind: 'definition', anchorType: 'node_a', startingEntity: 'asked', steps: [{ relationshipTypes: ['link_a'], direction: 'out', arrivesAt: 'node_b', conditions: [], windowed: false }] } };
  const held: AskPatternOffer = { ...OFFER, projection: { kind: 'definition', anchorType: 'node_a', startingEntity: 'held', steps: [] } };

  async function pattern(params: Record<string, unknown> = { patternId: PATTERN, patternVersion: 3, ref: { entityType: 'node_a', stableId: 'a-1' } }) {
    const plans = createMemoryPlanStore();
    const stored = await plans.insert({ userId: 'u-1', sourceId: 'demo', templateId: 'saved-pattern', templateVersion: 1, params, planningTraceId: 'tr-0' });
    const route = createAskEditRoute({ plans: () => plans, view: () => VIEW });
    const edit = (body: Record<string, unknown>, listing: { offers: readonly AskPatternOffer[]; cut: boolean } = { offers: [OFFER], cut: false }) =>
      route.handler(request({ planId: stored.id, templateId: 'saved-pattern', params: { patternId: PATTERN, patternVersion: 3, ref: ref('a-2') }, ...body }, { askPatternFind: async () => listing.offers[0] }));
    const refusal = async (promise: Promise<unknown>) => parseExtensionRefusal(await promise.catch((error: unknown) => error));
    return { plans, stored, edit, refusal };
  }

  it('stores a new plan with the new starting entity, the same pattern id and version, and cancels the old one', async () => {
    const { plans, stored, edit } = await pattern();
    const answer = askEditResponseSchema.parse(await edit({}));
    expect(answer.plan).toMatchObject({ templateId: 'saved-pattern', params: { patternId: PATTERN, patternVersion: 3, ref: { entityType: 'node_a', stableId: 'a-2' } } });
    expect(plans.plans.find((plan) => plan.id === stored.id)?.state).toBe('cancelled');
    expect(plans.plans.find((plan) => plan.id === answer.planId)).toMatchObject({ state: 'proposed', parentPlanId: stored.id, templateId: 'saved-pattern', sourceId: 'demo' });
  });

  it.each([
    ['another pattern id', { params: { patternId: '0195a000-0000-7000-8000-000000000002', patternVersion: 3, ref: ref('a-2') } }],
    ['another version', { params: { patternId: PATTERN, patternVersion: 4, ref: ref('a-2') } }],
    ['a field beside them', { params: { patternId: PATTERN, patternVersion: 3, ref: ref('a-2'), name: 'x' } }],
    ['no reference', { params: { patternId: PATTERN, patternVersion: 3 } }],
    ['a reference of another type than the pattern starts at', { params: { patternId: PATTERN, patternVersion: 3, ref: ref('b-1', 'demo', 'node_b') } }],
    ['a template other than the plan’s', { templateId: 'entity', params: { ref: ref('a-2') } }],
  ])('refuses an edit with %s as ASK_PLAN_INVALID and changes nothing', async (_name, body) => {
    const { plans, stored, edit, refusal } = await pattern();
    expect(await refusal(edit(body))).toEqual({ code: 'ASK_PLAN_INVALID' });
    expect(plans.plans).toEqual([stored]);
  });

  it('refuses a reference of another source with SOURCE_MISMATCH and changes nothing', async () => {
    const { plans, stored, edit, refusal } = await pattern();
    expect(await refusal(edit({ params: { patternId: PATTERN, patternVersion: 3, ref: ref('a-2', 'elsewhere') } }))).toEqual({ code: 'SOURCE_MISMATCH' });
    expect(plans.plans).toEqual([stored]);
  });

  it('refuses every edit of a plan whose pattern holds its starting entity, which has no reference to change', async () => {
    const { plans, stored, edit, refusal } = await pattern({ patternId: PATTERN, patternVersion: 3 });
    expect(await refusal(edit({}, { offers: [held], cut: false }))).toEqual({ code: 'ASK_PLAN_INVALID' });
    expect(plans.plans).toEqual([stored]);
  });

  it('refuses an edit when the pattern is no longer one the caller may run, was changed since, or now holds its starting entity', async () => {
    const { plans, stored, edit, refusal } = await pattern();
    for (const listing of [{ offers: [], cut: false }, { offers: [{ ...OFFER, version: 4 }], cut: false }, { offers: [held], cut: false }]) {
      expect(await refusal(edit({}, listing))).toEqual({ code: 'ASK_PLAN_INVALID' });
    }
    expect(plans.plans).toEqual([stored]);
  });

  it('refuses without a way to find the pattern, since it cannot be told to be there', async () => {
    const { plans, stored, refusal } = await pattern();
    const route = createAskEditRoute({ plans: () => plans, view: () => VIEW });
    expect(await refusal(route.handler(request({ planId: stored.id, templateId: 'saved-pattern', params: { patternId: PATTERN, patternVersion: 3, ref: ref('a-2') } })))).toEqual({ code: 'ASK_PLAN_INVALID' });
  });

  it('answers ASK_PLAN_INVALID for an edit of a linked plan above the hop bound of its source, and stores nothing; an edit at the bound is stored', async () => {
    const plans = createMemoryPlanStore();
    const stored = await plans.insert({ userId: 'u-1', sourceId: 'demo', templateId: 'linked-entities', templateVersion: 1, params: { ref: { entityType: 'node_a', stableId: 'a-1' }, targetType: 'node_b', via: ['link_a'], direction: 'out', maxHops: 1 }, planningTraceId: 'tr-0' });
    const bounded = { ...VIEW, maxHopsBySource: { demo: 2 } };
    const route = createAskEditRoute({ plans: () => plans, view: () => bounded });
    const edit = (maxHops: number) => route.handler(request({ planId: stored.id, templateId: 'linked-entities', params: { ref: ref('a-2'), targetType: 'node_b', via: ['link_a'], direction: 'out', maxHops } }));
    expect(parseExtensionRefusal(await edit(3).catch((error: unknown) => error))).toEqual({ code: 'ASK_PLAN_INVALID' });
    expect(plans.plans).toEqual([stored]);
    expect(await edit(2)).toMatchObject({ plan: { params: { maxHops: 2 } } });
  });
});
