import type { AskPlan, AskPlanner } from '@neburyx/contracts';
import { createEnterpriseExtension } from '@neburyx/ee-ask';
import { describe, expect, it, vi } from 'vitest';
import { communitySeams } from '../seams/community-seams.js';
import type { Seams } from '../seams/seams.js';
import { LISTED_PLAN_EXPIRY, LISTED_PLAN_ID, createListPlanStore } from '../testing/list-plan-store.js';
import { startSearchApp } from '../testing/search-app.js';

vi.mock('@neburyx/ee-audit', () => ({ createAuditSink: () => ({ sink: { record: () => Promise.resolve() }, close: async () => undefined }) }));

const listStore = createListPlanStore();
const stored = listStore.stored;
const PLAN_ID = LISTED_PLAN_ID;
const EXPIRES = LISTED_PLAN_EXPIRY;

const PLAN: AskPlan = { kind: 'unsupported', reason: 'No template fits.' };
const QUESTION = 'which are the same as W-001?';

async function startAsk(rows?: readonly Record<string, unknown>[], answer: unknown = PLAN, policy: Seams['policy'] = communitySeams().policy) {
  const texts: string[] = [];
  // a planner that answers something that is not a plan is the case under test, and the type forbids it
  const planner: AskPlanner = { availability: () => ({ available: true }), plan: async ({ text }) => (texts.push(text), answer as never) };
  const extension = createEnterpriseExtension({ planStore: listStore });
  const rig = await startSearchApp({ ...(rows === undefined ? {} : { rows }), appOptions: { extension, previewOn: true, seams: { ...communitySeams(), policy, askPlanner: planner } } });
  const post = (payload: unknown) => rig.app.inject({ method: 'POST', url: '/v1/ask/plan', payload: JSON.stringify(payload), headers: { 'content-type': 'application/json' } });
  return { ...rig, post, texts };
}

describe('the plan endpoint of the mounted application', () => {
  it('answers a preview with a hash for a question that names an entity, and hands the planner the previewed text once on the confirmation', async () => {
    const { post, texts, app } = await startAsk();
    const preview = await post({ message: QUESTION, sourceId: 'demo' });
    expect(preview.statusCode).toBe(200);
    const shown = preview.json();
    expect(shown).toEqual({ preview: expect.stringContaining('‹widget#1›'), previewHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(shown.preview).not.toContain('W-001');
    expect(texts).toEqual([]);

    const confirmed = await post({ message: QUESTION, sourceId: 'demo', send: true, previewHash: shown.previewHash });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toEqual({ plan: PLAN });
    expect(texts).toEqual([shown.preview]);
    await app.close();
  });

  it('answers the blocked tokens for a word that is not allowed, and calls no planner', async () => {
    const { post, texts, app } = await startAsk([]);
    const blocked = await post({ message: 'which zorvath', sourceId: 'demo' });
    expect(blocked.json()).toEqual({ blocked: { tokens: [{ text: 'zorvath', start: 6, end: 13 }] } });
    expect(texts).toEqual([]);
    await app.close();
  });

  it('refuses a send without a hash, and a question without a source, as an invalid request', async () => {
    const { post, app } = await startAsk();
    expect((await post({ message: QUESTION, sourceId: 'demo', send: true })).statusCode).toBe(400);
    const noSource = await post({ message: QUESTION });
    expect([noSource.statusCode, noSource.json().error.code]).toEqual([400, 'INVALID_REQUEST']);
    await app.close();
  });

  it('answers changed with the new preview when the hash is not the current one', async () => {
    const { post, texts, app } = await startAsk();
    const result = await post({ message: QUESTION, sourceId: 'demo', send: true, previewHash: '0'.repeat(64) });
    expect(result.json()).toMatchObject({ changed: true, preview: expect.stringContaining('‹widget#1›') });
    expect(texts).toEqual([]);
    await app.close();
  });

  it('answers the plan of the planner with its placeholder turned back into the entity, stored with an ID, and the planner received the previewed text', async () => {
    const planned: AskPlan = { kind: 'plan', templateId: 'shared-attribute', templateVersion: 1, params: { ref: { entityType: 'widget', stableId: '‹widget#1›' }, limit: 25 }, rationale: 'Widgets that share a gadget.' };
    const shape: AskPlan = { kind: 'plan', templateId: 'shared-attribute', templateVersion: 1, params: { ref: { entityType: 'widget', stableId: 'W-001' }, limit: 25 }, rationale: 'Widgets that share a gadget.' };
    const { post, texts, app } = await startAsk(undefined, planned);
    const shown = (await post({ message: QUESTION, sourceId: 'demo' })).json();
    const confirmed = await post({ message: QUESTION, sourceId: 'demo', send: true, previewHash: shown.previewHash });
    expect([confirmed.statusCode, confirmed.json()]).toEqual([200, { plan: shape, planId: PLAN_ID, expiresAt: EXPIRES.toISOString() }]);
    expect(stored.at(-1)).toMatchObject({ sourceId: 'demo', templateId: 'shared-attribute', params: shape.kind === 'plan' ? shape.params : undefined });
    expect(texts).toEqual([shown.preview]);
    await app.close();
  });

  it('answers INTERNAL_ERROR, and puts the value in neither the answer nor the log, when the planner answers something that is not a plan', async () => {
    const { post, app, lines } = await startAsk(undefined, { kind: 'plan', templateId: 'free-query', query: 'SENTINEL-VALUE' });
    const shown = (await post({ message: QUESTION, sourceId: 'demo' })).json();
    const confirmed = await post({ message: QUESTION, sourceId: 'demo', send: true, previewHash: shown.previewHash });
    expect([confirmed.statusCode, confirmed.json().error.code]).toEqual([500, 'INTERNAL_ERROR']);
    expect(confirmed.body + lines.join('')).not.toContain('SENTINEL');
    await app.close();
  });

  it('writes no typed text and no hash to the log', async () => {
    const { post, app, lines } = await startAsk();
    const shown = (await post({ message: QUESTION, sourceId: 'demo' })).json();
    await post({ message: QUESTION, sourceId: 'demo', send: true, previewHash: shown.previewHash });
    await post({ message: 'which zorvath', sourceId: 'demo' });
    const log = lines.join('');
    for (const secret of ['W-001', 'zorvath', shown.previewHash]) expect(log).not.toContain(secret);
    await app.close();
  });

  it('answers NOT_FOUND for a source that is not configured, and signs and sends nothing', async () => {
    const { post, texts, app } = await startAsk();
    for (const body of [{ message: QUESTION, sourceId: 'nope' }, { message: QUESTION, sourceId: 'nope', send: true, previewHash: '0'.repeat(64) }]) {
      const answer = await post(body);
      expect([answer.statusCode, answer.json().error.code]).toEqual([404, 'NOT_FOUND']);
    }
    expect(texts).toEqual([]);
    await app.close();
  });

  it('answers NOT_FOUND for a source the caller may not read, and signs and sends nothing', async () => {
    const { post, texts, app } = await startAsk(undefined, PLAN, { authorizeSource: async () => ({ allowed: false, reason: 'no' }) });
    const answer = await post({ message: QUESTION, sourceId: 'demo' });
    expect([answer.statusCode, answer.json().error.code]).toEqual([404, 'NOT_FOUND']);
    expect(texts).toEqual([]);
    await app.close();
  });
});
