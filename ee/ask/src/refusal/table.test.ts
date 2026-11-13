import { createHmac } from 'node:crypto';
import { ASK_REFUSAL_FAMILIES, type AiMappingView, type AskPlanner, type AuditEvent, type ExtensionRequest } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { createAuditedModelCall } from '../audited.js';
import { createAskPlanner } from '../planner/planner.js';
import { BUILT_IN_PROMPTS, buildPromptRegistry } from '../prompts.js';
import { createRequestBuilder } from '../request.js';
import { askPlanRoute, createAskPlanRoute } from '../routes/ask-plan.js';
import { createMemoryPlanStore } from '../testing/memory-plans.js';
import { buildPropertyRules } from '../rules.js';
import { createFixtureProvider, replyKey, type FixtureReply } from '../testing/fixture.js';
import { MODEL_FAMILIES, REFUSAL_SENTENCES } from './families.js';

const VIEW: AiMappingView = { types: [{ name: 'widget', kind: 'entity', properties: [] }] };
const QUESTION = 'which widgets are the same as widgets?';
const mac = (canonical: string): string => createHmac('sha256', 'test-key').update(canonical).digest('hex');

async function planning(first: FixtureReply, repair: FixtureReply = first) {
  const built = await buildPromptRegistry({});
  if (!built.ok) throw new Error(built.problems.join('; '));
  const events: AuditEvent[] = [];
  const provider = createFixtureProvider({ registry: built.registry, replies: { [replyKey('ask.plan', BUILT_IN_PROMPTS['ask.plan'].version)]: first, [replyKey('ask.plan.repair', BUILT_IN_PROMPTS['ask.plan.repair'].version)]: repair } });
  const model = createAuditedModelCall({ provider, configuration: { registry: built.registry, model: 'configured-model' }, sink: { record: async (event) => void events.push(event) } });
  const { rules } = buildPropertyRules({}, undefined);
  if (rules === undefined) throw new Error('no rules');
  const planner: AskPlanner = createAskPlanner({ model, requestBuilder: createRequestBuilder(rules), view: VIEW });
  let reads = 0;
  const request = (body: unknown): ExtensionRequest => ({
    principalId: 'p',
    principalRole: 'investigator',
    previewOn: true,
    traceId: 'tr-1',
    audit: { record: async () => undefined },
    askPlanner: planner,
    previewMac: mac,
    policyVersionOf: () => 'none',
    askEntityTools: () => ({ search: async () => ({ refs: [], unreferenced: 0, count: { quality: 'unknown', scope: 'exact matches' } }), lookup: async () => true, ensureSource: async () => void (reads += 1) }),
    body,
  });
  const route = createAskPlanRoute({ plans: () => createMemoryPlanStore(), vocabulary: () => ['widget'], resolve: async ({ message }) => ({ status: 'resolved', text: message, spans: [], placeholders: new Map(), capReached: false }) });
  async function ask() {
    const shown = (await route.handler(request({ message: QUESTION, sourceId: 'demo' }))) as { previewHash: string };
    const before = reads;
    const answer = await route.handler(request({ message: QUESTION, sourceId: 'demo', send: true, previewHash: shown.previewHash }));
    return { answer, planningEvents: events.filter((event) => event.action === 'ask.plan'), readsAfterPreview: reads - before };
  }
  return { ask, events };
}

describe('the table of refusal families, on the server', () => {
  it('has a sentence for every family of the list, which a new family fails until it has one', () => {
    for (const family of ASK_REFUSAL_FAMILIES) expect(REFUSAL_SENTENCES[family], family).toBeTruthy();
    expect(askPlanRoute.url).toBe('/v1/ask/plan');
  });

  it.each(MODEL_FAMILIES)('sends a recorded reply of the family %s through the endpoint and answers its sentence after one planning event', async (family) => {
    const reply: FixtureReply = { kind: 'ok', text: JSON.stringify({ kind: 'unsupported', family, reason: 'words of the model' }), usage: { kind: 'known', inputTokens: 1, outputTokens: 1 } };
    const { ask } = await planning(reply);
    const { answer, planningEvents } = await ask();
    expect(answer).toEqual({ plan: { kind: 'unsupported', family, reason: REFUSAL_SENTENCES[family] } });
    expect(planningEvents).toHaveLength(1);
  });

  it('answers plan-not-usable after two planning events (the call and its repair) when no reply can be used, and model-refused after one when the model declines', async () => {
    const bad: FixtureReply = { kind: 'ok', text: 'not json', usage: { kind: 'known', inputTokens: 1, outputTokens: 1 } };
    const unusable = await (await planning(bad)).ask();
    expect(unusable.answer).toEqual({ plan: { kind: 'unsupported', family: 'plan-not-usable', reason: REFUSAL_SENTENCES['plan-not-usable'] } });
    expect(unusable.planningEvents).toHaveLength(2);
    const declined = await (await planning({ kind: 'refused' })).ask();
    expect(declined.answer).toEqual({ plan: { kind: 'unsupported', family: 'model-refused', reason: REFUSAL_SENTENCES['model-refused'] } });
    expect(declined.planningEvents).toHaveLength(1);
  });

  it('adds no source read of its own to a refusal: only the own source check of the request before the planner, whatever the family', async () => {
    for (const family of MODEL_FAMILIES) {
      const { ask } = await planning({ kind: 'ok', text: JSON.stringify({ kind: 'unsupported', family }), usage: { kind: 'unknown' } });
      expect((await ask()).readsAfterPreview).toBe(1);
    }
  });
});
