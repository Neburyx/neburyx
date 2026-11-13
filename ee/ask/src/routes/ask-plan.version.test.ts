import { createHmac } from 'node:crypto';
import { askPlanResponseSchema, type AskPlan, type AskPlanner, type ExtensionRequest } from '@neburyx/contracts';
import { describe, expect, it, vi } from 'vitest';
import { previewHashOf, type PreviewMac } from '../preview/preview-hash.js';
import { createAskPlanRoute } from './ask-plan.js';

vi.mock('../allowlist/index.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../allowlist/index.js')>()), COMMON_WORDS_VERSION: 'common-words-changed' }));

const PLAN: AskPlan = { kind: 'unsupported', reason: 'No template fits.' };
const mac: PreviewMac = (canonical) => createHmac('sha256', 'k').update(canonical).digest('hex');
const MESSAGE = 'which are the same as the other';

describe('a word-list version that changed since the preview', () => {
  it('answers changed with the new hash, and does not call the planner, for a hash made under the earlier version', async () => {
    const calls: string[] = [];
    const planner: AskPlanner = { availability: () => ({ available: true }), plan: async ({ text }) => (calls.push(text), PLAN) };
    const route = createAskPlanRoute({ resolve: async ({ message }) => ({ status: 'resolved', text: message, spans: [], placeholders: new Map(), capReached: false }) });
    const request = (body: unknown): ExtensionRequest => ({
      principalId: 'p',
      principalRole: 'investigator',
      previewOn: true,
      traceId: 'tr',
      audit: { record: async () => undefined },
      askPlanner: planner,
      previewMac: mac,
      policyVersionOf: () => 'none',
      askEntityTools: () => ({ search: async () => ({ refs: [], unreferenced: 0, count: { quality: 'unknown', scope: 'exact matches' } }), lookup: async () => true, ensureSource: async () => undefined }),
      body,
    });
    const earlier = previewHashOf(mac, { text: MESSAGE, resolutions: [], policyVersion: 'none', wordListVersion: 'common-words-1' });
    const answer = askPlanResponseSchema.parse(await route.handler(request({ message: MESSAGE, sourceId: 'demo', send: true, previewHash: earlier })));
    const current = previewHashOf(mac, { text: MESSAGE, resolutions: [], policyVersion: 'none', wordListVersion: 'common-words-changed' });
    expect(answer).toEqual({ preview: MESSAGE, previewHash: current, changed: true });
    expect(calls).toEqual([]);
  });
});
