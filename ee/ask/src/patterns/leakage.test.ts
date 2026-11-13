import { askPlanResponseSchema, type AiMappingView, type AskPatternOffer, type ExtensionRequest } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { createAuditedModelCall } from '../audited.js';
import { createAskPlanner } from '../planner/index.js';
import { buildPromptRegistry } from '../prompts.js';
import { createRequestBuilder } from '../request.js';
import { createAskPlanRoute } from '../routes/ask-plan.js';
import { buildPropertyRules } from '../rules.js';
import { createFixtureProvider, replyKey } from '../testing/fixture.js';
import { createMemoryPlanStore } from '../testing/memory-plans.js';
import { questionVocabulary } from '../vocabulary/vocabulary.js';
import { buildPatternCatalog } from './catalog.js';
import { PatternGuardError, createPatternGuard } from './guard.js';
import type { PlaceholderSpan, resolveMentions } from '../resolution/index.js';
import { createHmac } from 'node:crypto';

const VIEW: AiMappingView = { types: [{ name: 'widget', kind: 'entity', properties: [] }, { name: 'gadget', kind: 'entity', properties: [] }, { name: 'link', kind: 'relationship', properties: [] }] };
const NAME = 'SECRET-PATTERN-NAME';
const ID = '0195a000-0000-7000-8000-00000000abcd';
const VALUE = 'SECRET-CONDITION-VALUE';
const OFFER: AskPatternOffer = { id: ID, version: 4, name: NAME, projection: { kind: 'definition', anchorType: 'widget', startingEntity: 'asked', steps: [{ relationshipTypes: ['link'], direction: 'out', arrivesAt: 'gadget', conditions: [{ on: 'neighbor', kind: 'eq' }], windowed: false }] } };
const PLACEHOLDER = '‹widget#1›';
const TYPED = 'Acme is the same as widgets';
const mac = (canonical: string): string => createHmac('sha256', 'key').update(canonical).digest('hex');
const SOURCE = 'demo';
const REF = { sourceId: SOURCE, entityType: 'widget', stableId: 'w-1' };

const holding: typeof resolveMentions = async ({ message }) => {
  const span: PlaceholderSpan = { start: 0, end: PLACEHOLDER.length, placeholder: PLACEHOLDER, typedStart: 0, typedEnd: 4 };
  return { status: 'resolved', text: `${PLACEHOLDER}${message.slice(4)}`, spans: [span], placeholders: new Map([[PLACEHOLDER, { kind: 'entity' as const, ref: REF }]]), capReached: false };
};

async function rig(first: string, repair: string) {
  const built = await buildPromptRegistry({});
  if (!built.ok) throw new Error(built.problems.join('; '));
  const provider = createFixtureProvider({ registry: built.registry, replies: { [replyKey('ask.plan', 5)]: { kind: 'ok', text: first }, [replyKey('ask.plan.repair', 3)]: { kind: 'ok', text: repair } } });
  const model = createAuditedModelCall({ provider, configuration: { registry: built.registry, model: 'm' }, sink: { record: async () => undefined } });
  const { rules } = buildPropertyRules({}, undefined);
  if (rules === undefined) throw new Error('rules');
  const planner = createAskPlanner({ model, requestBuilder: createRequestBuilder(rules), view: VIEW });
  const request = (body: unknown, listing: { offers: readonly AskPatternOffer[]; cut: boolean }): ExtensionRequest => ({
    principalId: 'p', principalRole: 'investigator', previewOn: true, traceId: 'tr-1', audit: { record: async () => undefined }, askPlanner: planner, previewMac: mac, policyVersionOf: () => 'none',
    askEntityTools: () => ({ search: async () => ({ refs: [], unreferenced: 0, count: { quality: 'unknown', scope: 'exact matches' } }), lookup: async () => true, ensureSource: async () => undefined }),
    askPatterns: async () => listing, body,
  });
  const texts = () => provider.calls.map((call) => built.registry.resolve(call.promptId, call.parameters).text);
  return { provider, request, texts };
}

const named = (key: string): string => JSON.stringify({ kind: 'plan', templateId: 'saved-pattern', templateVersion: 1, rationale: 'Fits.', params: { patternKey: key, ref: { entityType: 'widget', stableId: PLACEHOLDER } } });

async function confirm(first: string, repair: string, options: Partial<Parameters<typeof createAskPlanRoute>[0]> = {}, offers: readonly AskPatternOffer[] = [OFFER]) {
  const r = await rig(first, repair);
  const route = createAskPlanRoute({ resolve: holding, plans: () => createMemoryPlanStore(), view: () => VIEW, vocabulary: () => questionVocabulary({ view: VIEW }), ...options });
  const listing = { offers, cut: false };
  const shown = await route.handler(r.request({ message: TYPED, sourceId: SOURCE }, listing));
  const parsed = askPlanResponseSchema.parse(shown);
  if (!('previewHash' in parsed)) throw new Error('no preview');
  const { previewHash } = parsed;
  const send = () => route.handler(r.request({ message: TYPED, sourceId: SOURCE, send: true, previewHash }, listing));
  return { ...r, send };
}

describe('what reaches the model of a saved pattern', () => {
  it('holds no name, id or condition value of a pattern in any request of the turn, the repair included', async () => {
    const { send, texts, provider } = await confirm(named('pat_9'), named('pat_9'));
    expect(await send()).toMatchObject({ plan: { kind: 'unsupported' } });
    expect(provider.calls.map((call) => call.promptId)).toEqual(['ask.plan', 'ask.plan.repair']);
    for (const text of texts()) for (const secret of [NAME, ID, VALUE, 'SECRET']) expect(text).not.toContain(secret);
    expect(texts()[0]).toContain('pat_1: starts at an entity of type widget that the question gives');
  });

  it('plans when a pattern name is a word of the question, because the question is not scanned', async () => {
    const same = { ...OFFER, name: 'same' };
    const { send, provider } = await confirm(named('pat_1'), named('pat_1'), {}, [same]);
    expect(await send()).toMatchObject({ plan: { kind: 'plan', templateId: 'saved-pattern' } });
    expect(provider.calls).toHaveLength(1);
  });

  it('stops before any request when a catalog builder adds a name, a condition value and an id to the description', async () => {
    const leaky: typeof buildPatternCatalog = (listing, view) => {
      const real = buildPatternCatalog(listing, view);
      return real === undefined ? undefined : { ...real, catalog: { ...real.catalog, text: `${real.catalog.text}${NAME} ${VALUE} ${ID}\n` } };
    };
    const thrown: unknown = await confirm(named('pat_1'), named('pat_1'), { patternCatalog: leaky }).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(PatternGuardError);
    expect(thrown).toMatchObject({ kind: 'catalog' });
    expect(thrown instanceof Error ? thrown.message : '').not.toMatch(/SECRET|0195a000/);
  });

  it('stops before any request when an offer holds a name in a field that is meant for a type', async () => {
    const leaking: AskPatternOffer = { ...OFFER, projection: { ...OFFER.projection, anchorType: NAME } };
    expect(await confirm(named('pat_1'), named('pat_1'), {}, [leaking]).catch((error: unknown) => error)).toMatchObject({ name: 'PatternGuardError', kind: 'projection', position: 0 });
  });

  it('sends the leak of a catalog builder when the guard is a pass-through, so it is the guard that stops it', async () => {
    const guarded = [{ offer: OFFER, blocked: [], offered: false }];
    const real = buildPatternCatalog({ offers: [OFFER], cut: false }, VIEW);
    if (real === undefined) throw new Error('no catalog');
    const leakyText = `${real.catalog.text}${NAME} ${ID}\n`;
    const leaky = { ...real.catalog, text: leakyText };
    const run = async (check: (parameters: Readonly<Record<string, string | number>>) => void) => {
      const r = await rig(named('pat_1'), named('pat_1'));
      const { askPlanner: planner } = r.request({}, { offers: [], cut: false });
      const outcome: unknown = await planner.plan({ text: `${PLACEHOLDER} is the same as widgets`, context: { actorId: 'p', actorRole: 'investigator', traceId: 'tr' }, patterns: { ...leaky, check } }).catch((error: unknown) => error);
      return { outcome, texts: r.texts(), calls: r.provider.calls.length };
    };
    const stopped = await run(createPatternGuard(guarded, VIEW, leakyText).check);
    expect(stopped.outcome).toMatchObject({ name: 'PatternGuardError', kind: 'text' });
    expect(stopped.calls).toBe(0);
    const passed = await run(() => undefined);
    expect(passed.calls).toBeGreaterThan(0);
    expect(passed.texts.join('\n')).toContain(NAME);
  });
});
