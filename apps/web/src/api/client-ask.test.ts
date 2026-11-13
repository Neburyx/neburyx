import { describe, expect, it } from 'vitest';
import { createApiClient, type Fetcher } from './client.js';

const HASH = 'c'.repeat(64);

function answering(body: unknown, status = 200): { readonly fetcher: Fetcher; readonly seen: Array<{ input: string; method: string | undefined; body: string | undefined }> } {
  const seen: Array<{ input: string; method: string | undefined; body: string | undefined }> = [];
  return {
    seen,
    fetcher: async (input, init) => {
      seen.push({ input, method: init?.method, body: init?.body });
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    },
  };
}

describe('the API client, asking one question', () => {
  it('posts the request to /v1/ask/plan and returns each kind of answer', async () => {
    const request = { message: 'which accounts', sourceId: 'demo', send: false };
    for (const body of [
      { preview: 'which accounts', previewHash: HASH },
      { preview: 'which accounts', previewHash: HASH, changed: true },
      { blocked: { tokens: [{ text: 'zorvath', start: 6, end: 13 }] } },
      { plan: { kind: 'unsupported', family: 'other', reason: 'No template fits.' } },
    ]) {
      const { fetcher, seen } = answering(body);
      expect(await createApiClient(fetcher).askPlan(request)).toEqual({ ok: true, value: body });
      expect(seen).toEqual([{ input: '/v1/ask/plan', method: 'POST', body: JSON.stringify(request) }]);
    }
  });

  it('gives a schema mismatch for an answer of no known kind, and the server failure for a refusal', async () => {
    expect(await createApiClient(answering({ preview: 'x' }).fetcher).askPlan({ message: 'x', sourceId: 'demo' })).toEqual({ ok: false, failure: { code: 'SCHEMA_MISMATCH' } });
    const refusal = { error: { code: 'ASK_UNSUPPORTED', message: 'Ask is not available in this edition.', retryable: false, traceId: 'tr-1', details: { reason: 'not-in-this-edition' } } };
    expect(await createApiClient(answering(refusal, 422).fetcher).askPlan({ message: 'x', sourceId: 'demo' })).toMatchObject({ ok: false, failure: { code: 'ASK_UNSUPPORTED' } });
  });
});

describe('the API client, running, editing and cancelling a plan', () => {
  const PLAN = '0192f000-0000-7000-8000-0000000000a1';
  const OTHER = '0192f000-0000-7000-8000-0000000000a2';
  const node = { ref: { sourceId: 'demo', entityType: 'node_a', stableId: 'a-1' }, display: { title: 'A', type: 'node_a' }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } };
  const run = (planId = PLAN) => ({ planId, outcome: 'complete', result: { templateId: 'entity', result: node } });
  const plan = { kind: 'plan', templateId: 'entity', templateVersion: 1, rationale: 'one entity', params: { ref: { entityType: 'node_a', stableId: 'a-1' } } };

  it('posts a run to /v1/ask/run with its body and returns the answer for the plan that was sent', async () => {
    const request = { planId: PLAN, mask: true };
    const { fetcher, seen } = answering(run());
    expect(await createApiClient(fetcher).askRun(request)).toEqual({ ok: true, value: run() });
    expect(seen).toEqual([{ input: '/v1/ask/run', method: 'POST', body: JSON.stringify(request) }]);
  });

  it('refuses an answer for another plan, a result of no template, a heavy stop with no token and a bad outcome, as a schema mismatch', async () => {
    for (const body of [run(OTHER), { planId: PLAN, outcome: 'failed', result: { templateId: 'entity', result: node } }, { planId: PLAN, outcome: 'complete', result: { templateId: 'free-query', result: node } }, { planId: PLAN, outcome: 'partial' }]) {
      expect(await createApiClient(answering(body).fetcher).askRun({ planId: PLAN })).toEqual({ ok: false, failure: { code: 'SCHEMA_MISMATCH' } });
    }
  });

  it('posts an edit to /v1/ask/edit and returns the new plan with its own ID, which is not compared with the old one', async () => {
    const request = { planId: PLAN, templateId: 'entity' as const, params: { ref: { sourceId: 'demo', entityType: 'node_a', stableId: 'a-2' } } };
    const answer = { plan, planId: OTHER, expiresAt: '2026-11-13T10:15:00.000Z' };
    const { fetcher, seen } = answering(answer);
    expect(await createApiClient(fetcher).askEdit(request)).toEqual({ ok: true, value: answer });
    expect(seen).toEqual([{ input: '/v1/ask/edit', method: 'POST', body: JSON.stringify(request) }]);
    expect(await createApiClient(answering({ plan, planId: OTHER }).fetcher).askEdit(request)).toEqual({ ok: false, failure: { code: 'SCHEMA_MISMATCH' } });
  });

  it('posts a cancel to /v1/ask/cancel and refuses an answer for another plan', async () => {
    const { fetcher, seen } = answering({ planId: PLAN, state: 'cancelled' });
    expect(await createApiClient(fetcher).askCancel({ planId: PLAN })).toEqual({ ok: true, value: { planId: PLAN, state: 'cancelled' } });
    expect(seen).toEqual([{ input: '/v1/ask/cancel', method: 'POST', body: JSON.stringify({ planId: PLAN }) }]);
    expect(await createApiClient(answering({ planId: OTHER, state: 'cancelled' }).fetcher).askCancel({ planId: PLAN })).toEqual({ ok: false, failure: { code: 'SCHEMA_MISMATCH' } });
  });

  it('gives the failure the server answers, with its details, for each call', async () => {
    const conflict = { error: { code: 'CONFLICT', message: 'This plan has expired. Ask the question again to get a new plan.', retryable: false, traceId: 'tr-1', details: { reason: 'plan-expired' } } };
    const client = createApiClient(answering(conflict, 409).fetcher);
    for (const result of [await client.askRun({ planId: PLAN }), await client.askCancel({ planId: PLAN }), await client.askEdit({ planId: PLAN, templateId: 'entity', params: {} })]) {
      expect(result).toMatchObject({ ok: false, failure: { code: 'CONFLICT', details: { reason: 'plan-expired' } } });
    }
  });

  it('gives an aborted result and a network failure, as the other calls do', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await createApiClient(answering(run()).fetcher).askRun({ planId: PLAN }, controller.signal)).toEqual({ ok: false, failure: { code: 'ABORTED' } });
    const down: Fetcher = async () => Promise.reject(new Error('offline'));
    expect(await createApiClient(down).askRun({ planId: PLAN })).toEqual({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } });
  });
});
