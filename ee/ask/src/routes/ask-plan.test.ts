import { createHmac } from 'node:crypto';
import { askPlanResponseSchema, parseExtensionRefusal, type AskPlan, type AskPlanner, type AskResolution, type ElementRef, type ExtensionRequest } from '@neburyx/contracts';
import { describe, expect, it, vi } from 'vitest';
import { COMMON_WORDS_VERSION } from '../allowlist/index.js';
import { AuditUnavailableError } from '../audited.js';
import { previewHashOf, type PreviewMac } from '../preview/preview-hash.js';
import type { PlaceholderSpan, ResolutionOutcome, resolveMentions } from '../resolution/index.js';
import { createMemoryPlanStore } from '../testing/memory-plans.js';
import { REFUSAL_SENTENCES } from '../refusal/families.js';
import { questionVocabulary } from '../vocabulary/vocabulary.js';
import { askPlanRoute, createAskPlanRoute } from './ask-plan.js';

const PLAN: AskPlan = { kind: 'unsupported', reason: 'No template fits.' };
const FIXED_PLAN = { kind: 'unsupported', family: 'other', reason: REFUSAL_SENTENCES.other };
const SOURCE = 'demo';
const mac: PreviewMac = (canonical) => createHmac('sha256', 'test-key').update(canonical).digest('hex');
const REF = { sourceId: SOURCE, entityType: 'widget', stableId: 'w-1' };

interface Rig {
  readonly calls: { text: string; rest: string }[];
  readonly planner: AskPlanner;
  request(body: unknown, overrides?: Partial<ExtensionRequest>): ExtensionRequest;
}

function rig(planner?: (calls: Rig['calls']) => Promise<AskPlan>): Rig {
  const calls: Rig['calls'] = [];
  const spy: AskPlanner = {
    availability: () => ({ available: true }),
    plan: async (input) => {
      calls.push({ text: input.text, rest: JSON.stringify(Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'text'))) });
      return planner === undefined ? PLAN : planner(calls);
    },
  };
  return {
    calls,
    planner: spy,
    request: (body, overrides = {}) => ({
      principalId: 'p',
      principalRole: 'investigator',
      previewOn: true,
      traceId: 'tr-1',
      audit: { record: async () => undefined },
      askPlanner: spy,
      previewMac: mac,
      policyVersionOf: () => 'none',
      askEntityTools: () => ({ search: async () => ({ refs: [], unreferenced: 0, count: { quality: 'unknown', scope: 'exact matches' } }), lookup: async () => true, ensureSource: async () => undefined }),
      body,
      ...overrides,
    }),
  };
}

type Resolve = typeof resolveMentions;

/** A resolution that leaves the message as it is, with no mention. */
const plain: Resolve = async ({ message }) => ({ status: 'resolved', text: message, spans: [], placeholders: new Map(), capReached: false });

/** A resolution that replaces the first `length` characters of the message by one placeholder. */
const replacingFirst = (length: number, placeholder = '‹widget#1›'): Resolve => async ({ message }) => {
  const span: PlaceholderSpan = { start: 0, end: placeholder.length, placeholder, typedStart: 0, typedEnd: length };
  return { status: 'resolved', text: `${placeholder}${message.slice(length)}`, spans: [span], placeholders: new Map(), capReached: false };
};

const outcome = (value: ResolutionOutcome): Resolve => async () => value;

const stored = createMemoryPlanStore();
const route = (resolve: Resolve, vocabulary: readonly string[] = questionVocabulary({ view: { types: [{ name: 'Widget', kind: 'entity', properties: [{ name: 'sprocketTag', pii: false }] }] } })) => createAskPlanRoute({ resolve, vocabulary: () => vocabulary, plans: () => stored });

const MESSAGE = 'which widgets are the same as widgets?';

const previewOf = (result: unknown) => {
  const parsed = askPlanResponseSchema.parse(result);
  if (!('preview' in parsed)) throw new Error('no preview');
  return parsed;
};
const answer = async (r: ReturnType<typeof route>, rg: Rig, body: object, overrides?: Partial<ExtensionRequest>) => r.handler(rg.request({ message: MESSAGE, sourceId: SOURCE, ...body }, overrides));

describe('the Ask plan route as it was', () => {
  it('is a POST route with a request schema, and its default instance exists', () => {
    expect([askPlanRoute.method, askPlanRoute.url, askPlanRoute.permission, askPlanRoute.requestSchema === undefined]).toEqual(['POST', '/v1/ask/plan', 'principal', false]);
  });

  it('refuses with ASK_UNSUPPORTED and the reason not-in-this-edition, and never calls the planner, when the planner is not available', async () => {
    const rg = rig();
    const unavailable: AskPlanner = { availability: () => ({ available: false, reason: 'not_in_this_edition' }), plan: rg.planner.plan };
    const thrown = await route(plain).handler(rg.request({ message: MESSAGE, sourceId: SOURCE }, { askPlanner: unavailable })).catch((error: unknown) => error);
    expect(parseExtensionRefusal(thrown)).toEqual({ code: 'ASK_UNSUPPORTED', reason: 'not-in-this-edition' });
    expect(rg.calls).toEqual([]);
  });
});

describe('a request the route cannot serve or accept', () => {
  it('refuses, as unsupported and with no planner call, when the signing capability, the policy version or the tools are missing', async () => {
    const r = route(plain);
    for (const [body, overrides] of [
      [{ message: MESSAGE, sourceId: SOURCE }, { previewMac: undefined }],
      [{ message: MESSAGE, sourceId: SOURCE }, { policyVersionOf: undefined }],
      [{ message: MESSAGE, sourceId: SOURCE }, { askEntityTools: undefined }],
    ] as const) {
      const rg = rig();
      const thrown = await r.handler(rg.request(body, overrides)).catch((error: unknown) => error);
      expect(parseExtensionRefusal(thrown)).toEqual({ code: 'ASK_UNSUPPORTED', reason: 'not-in-this-edition' });
      expect(rg.calls).toEqual([]);
    }
  });

  it('refuses an unknown field, a bad hash, a send without a hash and a question without a source at the schema', () => {
    const schema = askPlanRoute.requestSchema;
    for (const body of [{ message: 'x', sourceId: SOURCE, allowWords: ['y'] }, { message: 'x', sourceId: SOURCE, previewHash: 'abc' }, { message: 'x', sourceId: SOURCE, send: true }, { message: 'x' }]) expect(schema?.safeParse(body).success).toBe(false);
  });

  it('refuses as an invalid request, with the reason, when the resolution refuses the choices', async () => {
    const rg = rig();
    const thrown = await route(outcome({ status: 'refused', reason: 'overlap' })).handler(rg.request({ message: MESSAGE, sourceId: SOURCE })).catch((error: unknown) => error);
    expect(parseExtensionRefusal(thrown)).toEqual({ code: 'INVALID_REQUEST', reason: 'overlap' });
    expect(rg.calls).toEqual([]);
  });
});

describe('a source that cannot be used and a resolution that takes too long', () => {
  it('passes the refusal of the source check on, and neither signs nor calls the planner', async () => {
    const rg = rig();
    const refusing = rg.request({ message: MESSAGE, sourceId: SOURCE }, { askEntityTools: () => ({ search: async () => ({ refs: [], unreferenced: 0, count: { quality: 'unknown', scope: 'exact matches' } }), lookup: async () => true, ensureSource: async () => Promise.reject(new Error('NOT_FOUND')) }) });
    await expect(route(plain).handler(refusing)).rejects.toThrow('NOT_FOUND');
    expect(rg.calls).toEqual([]);
  });

  it('refuses with QUERY_TIMEOUT and the limit when the resolution does not finish in time, and calls no planner', async () => {
    const rg = rig();
    const slow: Resolve = ({ signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    const thrown = await createAskPlanRoute({ resolve: slow, resolutionTimeoutMs: 5 }).handler(rg.request({ message: MESSAGE, sourceId: SOURCE })).catch((error: unknown) => error);
    expect(parseExtensionRefusal(thrown)).toEqual({ code: 'QUERY_TIMEOUT', timeoutMs: 5 });
    expect(rg.calls).toEqual([]);
  });
});

describe('the preview', () => {
  const allowed = 'which widgets are the same as widgets?';

  it('answers the rebuilt text and its hash, with the placeholder in place of the mention', async () => {
    const rg = rig();
    const result = await route(replacingFirst(4)).handler(rg.request({ message: 'Acme is the same as widgets', sourceId: SOURCE }));
    expect(result).toEqual({ preview: '‹widget#1› is the same as widgets', previewHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it('signs the rebuilt text with the resolutions, the policy version and the word-list version the module exports, and nothing else', async () => {
    const rg = rig();
    const resolutions: AskResolution[] = [{ start: 0, end: 4, ref: REF }];
    const result = await route(replacingFirst(4)).handler(rg.request({ message: 'Acme is the same as widgets', sourceId: SOURCE, resolutions }));
    const expected = previewHashOf(mac, { text: '‹widget#1› is the same as widgets', resolutions, policyVersion: 'none', wordListVersion: COMMON_WORDS_VERSION });
    expect(result).toMatchObject({ previewHash: expected });
  });

  it('gives the same hash for the same question and resolutions, and a different one for a different resolution, policy version or key', async () => {
    const r = route(replacingFirst(4));
    const ask = async (resolutions: AskResolution[], overrides?: Partial<ExtensionRequest>) => previewOf(await r.handler(rig().request({ message: 'Acme is the same as widgets', sourceId: SOURCE, resolutions }, overrides))).previewHash;
    const one: AskResolution[] = [{ start: 0, end: 4, ref: REF }];
    const base = await ask(one);
    expect(await ask(one)).toBe(base);
    expect(await ask([{ start: 0, end: 4, ref: { ...REF, stableId: 'w-2' } }])).not.toBe(base);
    expect(await ask(one, { policyVersionOf: () => 'two' })).not.toBe(base);
    expect(await ask(one, { previewMac: (canonical) => createHmac('sha256', 'other-key').update(canonical).digest('hex') })).not.toBe(base);
  });

  it('gives the same hash for two messages that differ only by whitespace', async () => {
    const r = route(plain);
    const ask = async (message: string) => r.handler(rig().request({ message, sourceId: SOURCE }));
    expect(await ask(allowed)).toEqual(await ask('  which   widgets are\tthe same   as widgets? '));
  });

  it('answers the blocked tokens with positions in the typed message, after a placeholder of another length, and no preview', async () => {
    const rg = rig();
    const result = await route(replacingFirst(9)).handler(rg.request({ message: 'Acme Corp is zorvath', sourceId: SOURCE }));
    expect(result).toEqual({ blocked: { tokens: [{ text: 'zorvath', start: 13, end: 20 }] } });
  });

  it('answers the typed slice for a blocked token that holds a placeholder', async () => {
    const rg = rig();
    const result = await route(replacingFirst(4)).handler(rg.request({ message: "Acme's widgets", sourceId: SOURCE }));
    expect(result).toEqual({ blocked: { tokens: [{ text: "Acme's", start: 0, end: 6 }] } });
  });

  it('answers the clarification, and no preview, even when the question also holds a blocked word', async () => {
    const clarification = { start: 0, end: 4, choices: [REF], count: { quality: 'exact' as const, value: 1, scope: 'exact matches' }, unreferenced: 0 };
    const rg = rig();
    const result = await route(outcome({ status: 'clarification', clarification })).handler(rg.request({ message: 'Acme zorvath', sourceId: SOURCE }));
    expect(result).toEqual({ clarification });
  });

  it('never calls the planner for a preview, a blocked question or a clarification', async () => {
    const rg = rig();
    await route(plain).handler(rg.request({ message: allowed, sourceId: SOURCE, send: false }));
    await route(plain).handler(rg.request({ message: 'zorvath', sourceId: SOURCE }));
    await route(outcome({ status: 'clarification', clarification: { start: 0, end: 4, choices: [], count: { quality: 'unknown', scope: 'exact matches' }, unreferenced: 0 } })).handler(rg.request({ message: 'Acme', sourceId: SOURCE }));
    expect(rg.calls).toEqual([]);
  });

  it('reads a type name of the mapping as a word and blocks an invented property name', async () => {
    const rg = rig();
    expect(await route(plain).handler(rg.request({ message: 'which widgets', sourceId: SOURCE }))).toMatchObject({ preview: 'which widgets' });
    expect(await route(plain).handler(rg.request({ message: 'which gizmoTag', sourceId: SOURCE }))).toEqual({ blocked: { tokens: [{ text: 'gizmoTag', start: 6, end: 14 }] } });
  });
});

describe('the confirmation', () => {
  const MESSAGE_OK = 'which widgets are the same as widgets?';
  const hashOf = async (rg: Rig, r = route(plain), overrides?: Partial<ExtensionRequest>) => {
    return previewOf(await r.handler(rg.request({ message: MESSAGE_OK, sourceId: SOURCE }, overrides)));
  };

  it('hands the planner exactly the rebuilt text of the preview, once, with no typed text in any other field, and answers the plan', async () => {
    const rg = rig();
    const shown = await hashOf(rg);
    const result = await route(plain).handler(rg.request({ message: MESSAGE_OK, sourceId: SOURCE, send: true, previewHash: shown.previewHash }));
    expect(result).toEqual({ plan: FIXED_PLAN });
    expect(rg.calls.map((call) => call.text)).toEqual([shown.preview]);
    for (const call of rg.calls) for (const word of MESSAGE_OK.split(/\W+/).filter((part) => part !== '')) expect(call.rest).not.toContain(word);
  });

  it('answers a refusal with the family the planner named and the fixed sentence of that family, never its own reason', async () => {
    const sentinel = 'Mr Sentinel ‹widget#1› 4111111111 w-1 secret-reason';
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => void logs.push(args.join(' ')));
    const rg = rig(async () => ({ kind: 'unsupported', family: 'judgement', reason: sentinel }));
    const shown = await hashOf(rg);
    const events: unknown[] = [];
    const result = await route(plain).handler(rg.request({ message: MESSAGE_OK, sourceId: SOURCE, send: true, previewHash: shown.previewHash }, { audit: { record: async (event: unknown) => void events.push(event) } as ExtensionRequest['audit'] }));
    spy.mockRestore();
    expect(result).toEqual({ plan: { kind: 'unsupported', family: 'judgement', reason: REFUSAL_SENTENCES.judgement } });
    expect(JSON.stringify([result, logs, events])).not.toContain('Sentinel');
    expect(Object.keys((result as { plan: object }).plan)).not.toContain('planId');
    expect(askPlanResponseSchema.safeParse(result).success).toBe(true);
  });

  it('answers other for a refusal that names no family, and the fixed sentence of the server-only families as the planner sets them', async () => {
    for (const family of ['plan-not-usable', 'model-refused'] as const) {
      const rg = rig(async () => ({ kind: 'unsupported', family, reason: 'x' }));
      const shown = await hashOf(rg);
      expect(await route(plain).handler(rg.request({ message: MESSAGE_OK, sourceId: SOURCE, send: true, previewHash: shown.previewHash }))).toEqual({ plan: { kind: 'unsupported', family, reason: REFUSAL_SENTENCES[family] } });
    }
  });

  it('makes no source read after the planner answers a refusal', async () => {
    const rg = rig();
    const shown = await hashOf(rg);
    let reads = 0;
    const tools = { search: async () => { reads += 1; return { refs: [], unreferenced: 0, count: { quality: 'unknown', scope: 'exact matches' } } as never; }, lookup: async () => { reads += 1; return true; }, ensureSource: async () => { reads += 1; } };
    const counted = rg.request({ message: MESSAGE_OK, sourceId: SOURCE, send: true, previewHash: shown.previewHash }, { askEntityTools: () => tools });
    const before = reads;
    const after: number[] = [];
    const original = counted.askPlanner.plan.bind(counted.askPlanner);
    await route(plain).handler({ ...counted, askPlanner: { ...counted.askPlanner, plan: async (input) => { after.push(reads); const plan = await original(input); after.push(reads); return plan; } } });
    expect(before).toBe(0);
    expect(after[1]).toBe(after[0]);
    expect(reads).toBe(after[1]);
  });

  it('hands the planner the actor, role, trace ID and source of the request as its context, and no text in it', async () => {
    const rg = rig();
    const shown = await hashOf(rg);
    await route(plain).handler(rg.request({ message: MESSAGE_OK, sourceId: SOURCE, send: true, previewHash: shown.previewHash }));
    expect(rg.calls.map((call) => JSON.parse(call.rest))).toEqual([{ context: { actorId: 'p', actorRole: 'investigator', traceId: 'tr-1', sourceId: SOURCE } }]);
  });

  it('answers AUDIT_UNAVAILABLE when the call of the planner could not be audited', async () => {
    const audit = rig(async () => Promise.reject(new AuditUnavailableError()));
    const shown = await hashOf(audit);
    const refusal = await route(plain).handler(audit.request({ message: MESSAGE_OK, sourceId: SOURCE, send: true, previewHash: shown.previewHash })).catch((error: unknown) => error);
    expect(parseExtensionRefusal(refusal)).toEqual({ code: 'AUDIT_UNAVAILABLE' });
  });

  it('answers the new preview with changed, and does not call the planner, after a resolution changed', async () => {
    const rg = rig();
    const first = await hashOf(rg);
    const result = await route(plain).handler(rg.request({ message: MESSAGE_OK, sourceId: SOURCE, send: true, previewHash: first.previewHash, resolutions: [{ start: 0, end: 5, value: true }] }));
    expect(result).toMatchObject({ preview: first.preview, changed: true });
    expect(previewOf(result).previewHash).not.toBe(first.previewHash);
    expect(rg.calls).toEqual([]);
  });

  it('answers changed, with no planner call, after the policy version changed', async () => {
    const rg = rig();
    const first = await hashOf(rg);
    const result = await route(plain).handler(rg.request({ message: MESSAGE_OK, sourceId: SOURCE, send: true, previewHash: first.previewHash }, { policyVersionOf: () => 'two' }));
    expect(result).toMatchObject({ changed: true });
    expect(rg.calls).toEqual([]);
  });

  it('answers changed for a well-formed hash that was never issued, and for a hash made with another key', async () => {
    const rg = rig();
    for (const hash of ['0'.repeat(64), previewHashOf((c) => createHmac('sha256', 'x').update(c).digest('hex'), { text: MESSAGE_OK, resolutions: [], policyVersion: 'none', wordListVersion: COMMON_WORDS_VERSION })]) {
      expect(await route(plain).handler(rg.request({ message: MESSAGE_OK, sourceId: SOURCE, send: true, previewHash: hash }))).toMatchObject({ changed: true });
    }
    expect(rg.calls).toEqual([]);
  });

  it('answers the blocked tokens or the clarification, and no planner call, when the question is no longer previewable', async () => {
    const rg = rig();
    const first = await hashOf(rg);
    const blocked = await route(plain).handler(rg.request({ message: 'which zorvath', sourceId: SOURCE, send: true, previewHash: first.previewHash }));
    expect(blocked).toMatchObject({ blocked: { tokens: [{ text: 'zorvath' }] } });
    const clarification = await route(outcome({ status: 'clarification', clarification: { start: 0, end: 4, choices: [], count: { quality: 'unknown', scope: 'exact matches' }, unreferenced: 0 } })).handler(rg.request({ message: 'Acme', sourceId: SOURCE, send: true, previewHash: first.previewHash }));
    expect(clarification).toHaveProperty('clarification');
    expect(rg.calls).toEqual([]);
  });

  it('passes a planner failure on, and the same request gives the same outcome again', async () => {
    const rg = rig(async () => Promise.reject(new Error('the planner failed')));
    const shown = await hashOf(rg);
    const post = async () => route(plain).handler(rg.request({ message: MESSAGE_OK, sourceId: SOURCE, send: true, previewHash: shown.previewHash })).catch((error: unknown) => (error instanceof Error ? error.message : 'other'));
    expect(await post()).toBe('the planner failed');
    expect(await post()).toBe('the planner failed');
    expect(rg.calls.length).toBe(2);
  });
});

describe('a plan that is stored', () => {
  const TYPED = 'Acme is the same as widgets';
  const PLACEHOLDER = '‹widget#1›';
  const entityPlan = (stableId = PLACEHOLDER): AskPlan => ({ kind: 'plan', templateId: 'entity', templateVersion: 1, rationale: 'Show the entity.', params: { ref: { entityType: 'widget', stableId } } });
  const holding = (ref: ElementRef): Resolve => async ({ message }) => {
    const span: PlaceholderSpan = { start: 0, end: PLACEHOLDER.length, placeholder: PLACEHOLDER, typedStart: 0, typedEnd: 4 };
    return { status: 'resolved', text: `${PLACEHOLDER}${message.slice(4)}`, spans: [span], placeholders: new Map([[PLACEHOLDER, { kind: 'entity' as const, ref }]]), capReached: false };
  };
  const confirm = async (rg: Rig, resolve: Resolve, plans = createMemoryPlanStore(), overrides?: Partial<ExtensionRequest>) => {
    const r = createAskPlanRoute({ resolve, plans: () => plans, vocabulary: () => questionVocabulary({ view: { types: [{ name: 'Widget', kind: 'entity', properties: [] }] } }) });
    const shown = previewOf(await r.handler(rg.request({ message: TYPED, sourceId: SOURCE }, overrides)));
    return { r, plans, send: () => r.handler(rg.request({ message: TYPED, sourceId: SOURCE, send: true, previewHash: shown.previewHash }, overrides)) };
  };

  it('is turned back into the reference of the map, stored as proposed for the caller and the source, and answered with its ID and expiry', async () => {
    const rg = rig(async () => entityPlan());
    const { send, plans } = await confirm(rg, holding(REF));
    const result = askPlanResponseSchema.parse(await send());
    expect(result).toMatchObject({ plan: { kind: 'plan', templateId: 'entity', params: { ref: { entityType: 'widget', stableId: 'w-1' } } } });
    expect(plans.plans).toHaveLength(1);
    const [stored] = plans.plans;
    expect(stored).toMatchObject({ userId: 'p', sourceId: SOURCE, templateId: 'entity', templateVersion: 1, state: 'proposed', planningTraceId: 'tr-1', params: { ref: { entityType: 'widget', stableId: 'w-1' } } });
    expect(result).toMatchObject({ planId: stored?.id, expiresAt: stored?.expiresAt.toISOString() });
  });

  it('holds no question text, no placeholder and no prompt in the row', async () => {
    const rg = rig(async () => entityPlan());
    const { send, plans } = await confirm(rg, holding(REF));
    await send();
    const row = JSON.stringify(plans.plans);
    for (const text of ['Acme', 'widgets', PLACEHOLDER, '‹', 'rationale', 'Show the entity']) expect(row).not.toContain(text);
  });

  it('stores nothing and has no ID for a plan that is unsupported', async () => {
    const rg = rig();
    const { send, plans } = await confirm(rg, holding(REF));
    expect(await send()).toEqual({ plan: FIXED_PLAN });
    expect(plans.plans).toEqual([]);
  });

  it('stores nothing and answers with the planner’s failure when the plan uses a placeholder the map does not hold', async () => {
    const rg = rig(async () => entityPlan('‹widget#9›'));
    const { send, plans } = await confirm(rg, holding(REF));
    const thrown = await send().catch((error: unknown) => error);
    expect(thrown).toMatchObject({ name: 'HydrationError', reason: 'unknown-placeholder' });
    expect(String((thrown as Error).message)).not.toMatch(/w-1|Acme|‹/);
    expect(plans.plans).toEqual([]);
  });

  it('refuses a reference of another source than the request’s and stores nothing', async () => {
    const rg = rig(async () => entityPlan());
    const { send, plans } = await confirm(rg, holding({ ...REF, sourceId: 'elsewhere' }));
    expect(await send().catch((error: unknown) => error)).toMatchObject({ name: 'HydrationError', reason: 'other-source' });
    expect(plans.plans).toEqual([]);
  });

  it('refuses with ASK_UNSUPPORTED before the planner is called when there is no store, and for the preview still answers it', async () => {
    const rg = rig(async () => entityPlan());
    const r = createAskPlanRoute({ resolve: holding(REF), vocabulary: () => questionVocabulary({ view: { types: [{ name: 'Widget', kind: 'entity', properties: [] }] } }) });
    const shown = previewOf(await r.handler(rg.request({ message: TYPED, sourceId: SOURCE })));
    const refusal = await r.handler(rg.request({ message: TYPED, sourceId: SOURCE, send: true, previewHash: shown.previewHash })).catch((error: unknown) => error);
    expect(parseExtensionRefusal(refusal)).toEqual({ code: 'ASK_UNSUPPORTED', reason: 'not-in-this-edition' });
    expect(rg.calls).toEqual([]);
  });

  it('returns no plan and no ID when the store fails after the model call, and the model call was made', async () => {
    const rg = rig(async () => entityPlan());
    const plans = createMemoryPlanStore();
    const { send } = await confirm(rg, holding(REF), plans);
    plans.failNext('insert');
    const thrown = await send().catch((error: unknown) => error);
    expect(thrown).toMatchObject({ name: 'PlanStoreError', code: 'PLAN_STORE_FAILED' });
    expect(rg.calls).toHaveLength(1);
    expect(plans.plans).toEqual([]);
  });
});
