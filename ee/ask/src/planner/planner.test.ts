import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiMappingView, AskPlanContext, AuditEvent } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { createAuditedModelCall } from '../audited.js';
import { buildPromptRegistry } from '../prompts.js';
import { createRequestBuilder } from '../request.js';
import { buildPropertyRules } from '../rules.js';
import { createFixtureProvider, replyKey, type FixtureReply } from '../testing/fixture.js';
import { catalogText } from './catalog.js';
import { vocabularyText } from './vocabulary-text.js';
import { MODEL_DECLINED } from './reply.js';
import { INVALID_PLAN_REASON, MODEL_REFUSED_REASON, PlannerCallFailed, createAskPlanner } from './planner.js';
import { BUILT_IN_PROMPTS } from '../prompts.js';

const TEXT = 'Which are the same as ‹widget#1›?';
const CONTEXT: AskPlanContext = { actorId: '01939999-0000-7000-8000-0000000000aa', actorRole: 'investigator', traceId: 'tr-9', sourceId: 'demo' };
const PLAN = { kind: 'plan', templateId: 'shared-attribute', templateVersion: 1, params: { ref: { entityType: 'widget', stableId: '‹widget#1›' }, attributeType: 'attr_type', via: 'attr_link' }, rationale: 'Records that share an attribute.' };

const DEFAULT_VIEW: AiMappingView = { types: [{ name: 'widget', kind: 'entity', properties: [] }, { name: 'attr_type', kind: 'entity', properties: [] }, { name: 'attr_link', kind: 'relationship', properties: [], ends: [{ from: 'widget', to: 'attr_type', timed: false }] }] };

async function rig(reply: FixtureReply | (() => never), options: { readonly overrides?: Record<string, string>; readonly view?: AiMappingView; readonly repair?: FixtureReply } = {}) {
  const built = await buildPromptRegistry(options.overrides ?? {});
  if (!built.ok) throw new Error(built.problems.join('; '));
  const events: AuditEvent[] = [];
  const provider = createFixtureProvider({ registry: built.registry, replies: { [replyKey('ask.plan', BUILT_IN_PROMPTS['ask.plan'].version)]: reply, [replyKey('ask.plan.repair', BUILT_IN_PROMPTS['ask.plan.repair'].version)]: options.repair ?? reply } });
  const model = createAuditedModelCall({ provider, configuration: { registry: built.registry, model: 'configured-model' }, sink: { record: async (event) => void events.push(event) } });
  const { rules, problems } = buildPropertyRules({}, undefined);
  if (rules === undefined) throw new Error(problems.join('; '));
  const planner = createAskPlanner({ model, requestBuilder: createRequestBuilder(rules), view: options.view ?? DEFAULT_VIEW });
  return { planner, provider, events };
}

const ok = (text: string): FixtureReply => ({ kind: 'ok', text, usage: { kind: 'known', inputTokens: 12, outputTokens: 34 } });

describe('the planner', () => {
  it('returns the plan a recorded reply holds, after one audited call with the question unchanged and only the catalog and the vocabulary besides', async () => {
    const { planner, provider, events } = await rig(ok(JSON.stringify(PLAN)));
    expect(await planner.plan({ text: TEXT, context: CONTEXT })).toEqual(PLAN);
    expect(provider.calls).toEqual([{ promptId: 'ask.plan', parameters: { catalog: catalogText(), vocabulary: vocabularyText(DEFAULT_VIEW), patterns: '', question: TEXT } }]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: 'ask.plan', result: 'success', actorId: CONTEXT.actorId, actorRole: 'investigator', traceId: 'tr-9', sourceId: 'demo', detail: { ai: { modelRef: 'fixture-model', promptId: 'ask.plan', promptVersion: '5', tokensIn: 12, tokensOut: 34 } } });
    expect(JSON.stringify(events)).not.toContain('widget#1');
  });

  it('reads a plan from a fenced block, and from nothing else around it', async () => {
    const fenced = await rig(ok('```json\n' + JSON.stringify(PLAN) + '\n```'));
    expect(await fenced.planner.plan({ text: TEXT, context: CONTEXT })).toEqual(PLAN);
    const chatty = await rig(ok('Here is the plan: ' + JSON.stringify(PLAN)));
    expect(await chatty.planner.plan({ text: TEXT, context: CONTEXT })).toEqual({ kind: 'unsupported', family: 'plan-not-usable', reason: INVALID_PLAN_REASON });
  });

  it.each([['text that is not JSON', 'no plan'], ['JSON that is not a plan', '{"kind":"plan","templateId":"free-query","query":"x"}'], ['a plan with a field of text beside its parameters', JSON.stringify({ ...PLAN, query: 'x' })]])('treats %s as an invalid reply', async (_name, text) => {
    const { planner } = await rig(ok(text));
    expect(await planner.plan({ text: TEXT, context: CONTEXT })).toEqual({ kind: 'unsupported', family: 'plan-not-usable', reason: INVALID_PLAN_REASON });
  });

  it('answers unsupported with the refusal reason when the model refuses, and records the call as refused', async () => {
    const { planner, events } = await rig({ kind: 'refused', usage: { kind: 'unknown' } });
    expect(await planner.plan({ text: TEXT, context: CONTEXT })).toEqual({ kind: 'unsupported', family: 'model-refused', reason: MODEL_REFUSED_REASON });
    expect(events[0]).toMatchObject({ result: 'refused' });
  });

  it('fails with the code of the failure, after its audit event, when the call fails, and returns no plan', async () => {
    const { planner, events } = await rig({ kind: 'failed', code: 'rate-limited' });
    const failure = await planner.plan({ text: TEXT, context: CONTEXT }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PlannerCallFailed);
    expect(failure).toMatchObject({ code: 'rate-limited' });
    expect(events[0]).toMatchObject({ result: 'failed' });
  });

  it('passes on what the provider throws, after recording the failure', async () => {
    const { planner, events } = await rig(() => {
      throw new Error('provider down');
    });
    await expect(planner.plan({ text: TEXT, context: CONTEXT })).rejects.toThrow('provider down');
    expect(events[0]).toMatchObject({ result: 'failed' });
  });

  it('is available, and the context it is given holds ids only', async () => {
    const { planner } = await rig(ok(JSON.stringify(PLAN)));
    expect(planner.availability()).toEqual({ available: true });
    expect(Object.keys(CONTEXT).sort()).toEqual(['actorId', 'actorRole', 'sourceId', 'traceId']);
  });
});

describe('the prompt the planner sends', () => {
  const folder = mkdtempSync(join(tmpdir(), 'planner-'));
  afterAll(() => rmSync(folder, { recursive: true, force: true }));
  const VIEW: AiMappingView = { types: [{ name: 'node_a', kind: 'entity', properties: [{ name: 'SECRET-PROPERTY', pii: false }] }, { name: 'LINKS', kind: 'relationship', properties: [{ name: 'SECRET-WEIGHT', pii: false }], ends: [{ from: 'node_a', to: 'node_a', timed: true }] }], derivedRules: [{ id: 'shared', from: 'node_a', to: 'node_a' }] };

  it('carries the vocabulary of the mapping by name only, so no property name or value reaches the model', async () => {
    const { planner, provider } = await rig(ok(JSON.stringify(PLAN)), { view: VIEW });
    await planner.plan({ text: TEXT, context: CONTEXT });
    const sent = JSON.stringify(provider.calls);
    expect(sent).toContain('LINKS: node_a -> node_a, has a time');
    expect(sent).toContain('shared: node_a -> node_a');
    expect(sent).not.toContain('SECRET');
    expect(Object.keys(provider.calls[0]?.parameters ?? {}).sort()).toEqual(['catalog', 'patterns', 'question', 'vocabulary']);
  });

  it('accepts an operator\'s override with the parameters of version 2 and audits the hash of the override file', async () => {
    const text = 'Plan {{question}} with {{catalog}} and {{vocabulary}}.';
    const path = join(folder, 'ask-plan.txt');
    writeFileSync(path, text);
    const { planner, events } = await rig(ok(JSON.stringify(PLAN)), { overrides: { 'ask.plan': path } });
    expect(await planner.plan({ text: TEXT, context: CONTEXT })).toEqual(PLAN);
    expect(events[0]).toMatchObject({ detail: { ai: { promptId: 'ask.plan', promptSha256: createHash('sha256').update(text, 'utf8').digest('hex') } } });
  });
});

describe('a recorded reply for each template', () => {
  const VIEW: AiMappingView = {
    types: [
      { name: 'widget', kind: 'entity', properties: [] },
      { name: 'attr_type', kind: 'entity', properties: [] },
      { name: 'attr_link', kind: 'relationship', properties: [], ends: [{ from: 'widget', to: 'attr_type', timed: true }] },
    ],
    derivedRules: [{ id: 'rule_a', from: 'widget', to: 'widget' }],
  };
  const QUESTION = 'about ‹widget#1› and ‹widget#2› and ‹value#1›';
  const A = { entityType: 'widget', stableId: '‹widget#1›' };
  const B = { entityType: 'widget', stableId: '‹widget#2›' };
  const plan = (templateId: string, params: Record<string, unknown>) => ({ kind: 'plan', templateId, templateVersion: 1, params, rationale: 'A plan.' });
  const REPLIES = [
    plan('shared-attribute', { ref: A, attributeType: 'attr_type', via: 'attr_link', window: { days: 90 }, limit: 25 }),
    plan('linked-entities', { ref: A, targetType: 'attr_type', via: ['attr_link'], direction: 'out', maxHops: 1 }),
    plan('entity', { ref: A }),
    plan('degree-preview', { ref: A }),
    plan('expand', { ref: A, relTypes: ['attr_link'], neighborTypes: ['attr_type'], direction: 'out', sort: 'observed', limit: 25 }),
    plan('derived-rule-run', { ref: A, ruleId: 'rule_a' }),
    plan('derived-edge-support', { ruleId: 'rule_a', ends: [A, B] }),
    plan('search', { entityTypes: ['attr_type'], text: '‹value#1›' }),
  ];

  it.each(REPLIES)('comes back unchanged for a $templateId reply', async (reply) => {
    const { planner } = await rig(ok(JSON.stringify(reply)), { view: VIEW });
    expect(await planner.plan({ text: QUESTION, context: CONTEXT })).toEqual(reply);
  });

  it('turns a reply that names a type outside the vocabulary into an unsupported plan', async () => {
    const { planner } = await rig(ok(JSON.stringify(plan('entity', { ref: { entityType: 'gadget', stableId: '‹widget#1›' } }))), { view: VIEW });
    expect(await planner.plan({ text: QUESTION, context: CONTEXT })).toEqual({ kind: 'unsupported', family: 'plan-not-usable', reason: INVALID_PLAN_REASON });
  });
});

describe('one repair, then unsupported', () => {
  const REPAIR = JSON.stringify(PLAN);
  const BAD_REPLY = JSON.stringify({ ...PLAN, params: { ref: { entityType: 'widget', stableId: 'A-1' }, attributeType: 'attr_type', via: 'attr_link' } });

  it('makes exactly one repair call, with the catalog, the vocabulary, the text, the first reply and the problems by path, and returns the repaired plan, both calls audited', async () => {
    const { planner, provider, events } = await rig(ok(BAD_REPLY), { repair: ok(REPAIR) });
    expect(await planner.plan({ text: TEXT, context: CONTEXT })).toEqual(PLAN);
    expect(provider.calls.map((call) => call.promptId)).toEqual(['ask.plan', 'ask.plan.repair']);
    const repair = provider.calls[1]?.parameters;
    expect(Object.keys(repair ?? {}).sort()).toEqual(['catalog', 'patterns', 'problems', 'question', 'reply', 'vocabulary']);
    expect(repair).toMatchObject({ question: TEXT, reply: BAD_REPLY, problems: 'params.ref.stableId: not an entity placeholder of the question' });
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.action)).toEqual(['ask.plan', 'ask.plan']);
    expect(events.map((event) => (event.detail as { ai: { promptId: string } }).ai.promptId)).toEqual(['ask.plan', 'ask.plan.repair']);
  });

  it('answers unsupported with the reason invalid-plan, and makes no third call, when the repaired reply is invalid too', async () => {
    const { planner, provider } = await rig(ok(BAD_REPLY), { repair: ok('still no plan') });
    expect(await planner.plan({ text: TEXT, context: CONTEXT })).toEqual({ kind: 'unsupported', family: 'plan-not-usable', reason: INVALID_PLAN_REASON });
    expect(provider.calls).toHaveLength(2);
  });

  it('makes no repair call for a valid first reply, nor for an unsupported answer of the model', async () => {
    const valid = await rig(ok(JSON.stringify(PLAN)));
    await valid.planner.plan({ text: TEXT, context: CONTEXT });
    expect(valid.provider.calls).toHaveLength(1);
    const declined = { kind: 'unsupported', reason: 'The question asks for a judgement.' };
    const answered = await rig(ok(JSON.stringify(declined)));
    expect(await answered.planner.plan({ text: TEXT, context: CONTEXT })).toEqual({ kind: 'unsupported', family: 'other', reason: MODEL_DECLINED });
    expect(answered.provider.calls).toHaveLength(1);
    const odd = await rig(ok(JSON.stringify({ kind: 'unsupported', family: 'made-up', extra: 1 })));
    expect(await odd.planner.plan({ text: TEXT, context: CONTEXT })).toEqual({ kind: 'unsupported', family: 'other', reason: MODEL_DECLINED });
    expect(odd.provider.calls).toHaveLength(1);
  });

  it('puts only paths, codes and the model\'s own reply in the repair call, and no word of a value the plan held', async () => {
    const { planner, provider } = await rig(ok(BAD_REPLY), { repair: ok(REPAIR) });
    await planner.plan({ text: TEXT, context: CONTEXT });
    expect(String(provider.calls[1]?.parameters['problems'])).not.toMatch(/A-1|widget#1|‹/);
  });

  it('answers a refusal of the repair call as a refusal, and passes a failure of it on, as the first call does', async () => {
    const refused = await rig(ok(BAD_REPLY), { repair: { kind: 'refused', usage: { kind: 'unknown' } } });
    expect(await refused.planner.plan({ text: TEXT, context: CONTEXT })).toEqual({ kind: 'unsupported', family: 'model-refused', reason: MODEL_REFUSED_REASON });
    const failed = await rig(ok(BAD_REPLY), { repair: { kind: 'failed', code: 'timeout' } });
    await expect(failed.planner.plan({ text: TEXT, context: CONTEXT })).rejects.toBeInstanceOf(PlannerCallFailed);
  });
});

describe('saved patterns offered with the question', () => {
  const CATALOG = { text: 'Saved patterns of the investigator.\npat_1: starts at an entity of type widget that the question gives; step 1: out over attr_link to attr_type, no conditions\n\n', entries: new Map([['pat_1', { anchorType: 'widget', startingEntity: 'asked' as const }]]), cut: false, labels: [], check: () => undefined };
  const SAVED = { kind: 'plan', templateId: 'saved-pattern', templateVersion: 1, params: { patternKey: 'pat_1', ref: { entityType: 'widget', stableId: '‹widget#1›' } }, rationale: 'The saved pattern fits.' };

  it('sends the pattern catalog as its own parameter, after the catalog and the vocabulary, and returns a plan that names an offered key', async () => {
    const { planner, provider } = await rig(ok(JSON.stringify(SAVED)));
    expect(await planner.plan({ text: TEXT, context: CONTEXT, patterns: CATALOG })).toEqual(SAVED);
    expect(provider.calls).toEqual([{ promptId: 'ask.plan', parameters: { catalog: catalogText(), vocabulary: vocabularyText(DEFAULT_VIEW), patterns: CATALOG.text, question: TEXT } }]);
  });

  it('sends the catalog again in the repair call and, when the key is not offered, answers unsupported after one repair without the key in either problem list', async () => {
    const wrong = { ...SAVED, params: { patternKey: 'pat_9', ref: SAVED.params.ref } };
    const { planner, provider } = await rig(ok(JSON.stringify(wrong)));
    expect(await planner.plan({ text: TEXT, context: CONTEXT, patterns: CATALOG })).toEqual({ kind: 'unsupported', family: 'plan-not-usable', reason: INVALID_PLAN_REASON });
    expect(provider.calls.map((call) => call.promptId)).toEqual(['ask.plan', 'ask.plan.repair']);
    for (const call of provider.calls) expect(call.parameters['patterns']).toBe(CATALOG.text);
    expect(String(provider.calls[1]?.parameters['problems'])).toBe('params.patternKey: not a key of the saved patterns offered');
  });

  it('repairs a plan that names the pattern but gives no starting entity, when the repair names it', async () => {
    const bare = { ...SAVED, params: { patternKey: 'pat_1' } };
    const { planner, provider } = await rig(ok(JSON.stringify(bare)), { repair: ok(JSON.stringify(SAVED)) });
    expect(await planner.plan({ text: TEXT, context: CONTEXT, patterns: CATALOG })).toEqual(SAVED);
    expect(String(provider.calls[1]?.parameters['problems'])).toBe('params.ref: the saved pattern asks for its starting entity');
  });

  it('offers no key when there is no catalog, so a plan that names a pattern is invalid and the section sent is empty', async () => {
    const { planner, provider } = await rig(ok(JSON.stringify(SAVED)));
    expect(await planner.plan({ text: TEXT, context: CONTEXT })).toEqual({ kind: 'unsupported', family: 'plan-not-usable', reason: INVALID_PLAN_REASON });
    expect(provider.calls.every((call) => call.parameters['patterns'] === '')).toBe(true);
  });

  it('reports a malformed pattern plan by path and code only', async () => {
    const malformed = { ...SAVED, params: { patternKey: 'a name', extra: 1 } };
    const { planner, provider } = await rig(ok(JSON.stringify(malformed)));
    await planner.plan({ text: TEXT, context: CONTEXT, patterns: CATALOG });
    const problems = String(provider.calls[1]?.parameters['problems']);
    expect(problems).toContain('params.patternKey: invalid_format');
    expect(problems).not.toContain('a name');
  });

  it('offers patterns exactly when the prompt in use has a place for them', async () => {
    const { planner } = await rig(ok(JSON.stringify(PLAN)));
    expect(planner.offersPatterns?.()).toBe(true);
    const folder = mkdtempSync(join(tmpdir(), 'planner-offers-'));
    try {
      const path = join(folder, 'plan.txt');
      writeFileSync(path, 'Plan {{question}} with {{catalog}} and {{vocabulary}}.');
      const { planner: overridden } = await rig(ok(JSON.stringify(PLAN)), { overrides: { 'ask.plan': path } });
      expect(overridden.offersPatterns?.()).toBe(false);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('records how many patterns were offered and the hash of the text sent in the event of each call, and nothing when none was', async () => {
    const wrong = { ...SAVED, params: { patternKey: 'pat_9', ref: SAVED.params.ref } };
    const withCatalog = await rig(ok(JSON.stringify(wrong)));
    await withCatalog.planner.plan({ text: TEXT, context: CONTEXT, patterns: CATALOG });
    const sha = createHash('sha256').update(CATALOG.text, 'utf8').digest('hex');
    expect(withCatalog.events).toHaveLength(2);
    for (const event of withCatalog.events) expect(event.detail).toMatchObject({ ai: { patternCatalog: { count: 1, sha256: sha } } });
    expect(JSON.stringify(withCatalog.events)).not.toContain('structure');
    const without = await rig(ok(JSON.stringify(PLAN)));
    await without.planner.plan({ text: TEXT, context: CONTEXT });
    expect(JSON.stringify(without.events[0]?.detail)).not.toContain('patternCatalog');
  });
});
