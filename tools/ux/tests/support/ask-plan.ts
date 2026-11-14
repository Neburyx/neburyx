import type { Page } from '@playwright/test';
import { ASK_HASH, askPanel, openAsk, previewQuestion } from './ask-panel.ts';

export const PLAN_ID = '0192f000-0000-7000-8000-0000000000a1';
export const NEW_PLAN_ID = '0192f000-0000-7000-8000-0000000000a2';
const EXPIRES = '2099-01-01T10:15:00.000Z';
const REF = { sourceId: 'banking-demo', entityType: 'account', stableId: 'AC-1' };
const node = (stableId: string) => ({ ref: { ...REF, stableId }, display: { title: stableId, type: 'account' }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } });
const PLAN = { kind: 'plan', templateId: 'shared-attribute', templateVersion: 1, rationale: 'Accounts that share a device.', params: { ref: { entityType: 'account', stableId: 'AC-1' }, attributeType: 'device', via: 'USES_DEVICE', window: { days: 30 }, limit: 25 } };

export interface AskPlanRequests {
  /** The bodies of the requests to the run, edit and cancel endpoints, in order, each with its path. */
  readonly calls: Array<{ readonly path: string; readonly body: Record<string, unknown> }>;
}

export type RunScript = 'complete' | 'heavy' | 'expired' | 'summary';

/** Answers the endpoints of a plan so a spec can reach each state: a confirmed question is answered with a plan, and a run, an edit and a cancel are answered as the script says. */
export async function scriptPlan(page: Page, run: RunScript = 'complete'): Promise<AskPlanRequests> {
  const seen: AskPlanRequests = { calls: [] };
  await page.route((url) => url.pathname === '/v1/ask/plan', async (route) => {
    const body: Record<string, unknown> = route.request().postDataJSON();
    if (body.send === true) return route.fulfill({ json: { plan: PLAN, planId: PLAN_ID, expiresAt: EXPIRES } });
    return route.fulfill({ json: { preview: 'Which accounts share the same device as ‹account#1›?', previewHash: ASK_HASH } });
  });
  await page.route((url) => url.pathname === '/v1/ask/run', async (route) => {
    const body: Record<string, unknown> = route.request().postDataJSON();
    seen.calls.push({ path: '/v1/ask/run', body });
    if (run === 'expired') return route.fulfill({ status: 409, json: { error: { code: 'CONFLICT', message: 'This plan has expired. Ask the question again to get a new plan.', retryable: false, traceId: 'tr-1', details: { reason: 'plan-expired' } } } });
    if (run === 'heavy' && body.continue !== true) {
      const result = { status: 'heavy', templateId: 'shared-attribute', templateVersion: '1', estimate: { quality: 'lowerBound', value: 500, scope: 'template:shared-attribute:estimate' }, threshold: 500, continueLimit: 25, notices: [], warnings: [] };
      return route.fulfill({ json: { planId: PLAN_ID, outcome: 'partial', result: { templateId: 'shared-attribute', result }, continueToken: 'c'.repeat(64) } });
    }
    const result = { status: 'ok', templateId: 'shared-attribute', templateVersion: '1', count: { quality: 'exact', value: 1, scope: 'template:shared-attribute' }, matchIds: [node('AC-2').ref], nodes: [node('AC-1'), node('AC-2')], edges: [], notices: [], warnings: [] };
    if (run === 'summary') {
      const citation = (key: string, stableId: string) => ({ key, element: node(stableId).ref, type: 'account', title: stableId });
      const long = 'Other records that share a device with AC-1: 1 · exact, which is a long sentence that has to wrap inside the narrow window and never push the page sideways, whatever its length is.';
      const summary = { sentences: [{ text: long, cites: ['n1'] }, { text: 'It is AC-2.', cites: ['n2'] }], citations: [citation('n1', 'AC-1'), citation('n2', 'AC-2')], omissions: '1 shown.' };
      return route.fulfill({ json: { planId: PLAN_ID, outcome: 'complete', result: { templateId: 'shared-attribute', result }, summary } });
    }
    return route.fulfill({ json: { planId: PLAN_ID, outcome: 'complete', result: { templateId: 'shared-attribute', result } } });
  });
  await page.route((url) => url.pathname === '/v1/ask/edit', async (route) => {
    const body: Record<string, unknown> = route.request().postDataJSON();
    seen.calls.push({ path: '/v1/ask/edit', body });
    const params = body.params as Record<string, unknown>;
    return route.fulfill({ json: { plan: { ...PLAN, params: { ...PLAN.params, limit: params.limit } }, planId: NEW_PLAN_ID, expiresAt: EXPIRES } });
  });
  await page.route((url) => url.pathname === '/v1/ask/cancel', async (route) => {
    const body: Record<string, unknown> = route.request().postDataJSON();
    seen.calls.push({ path: '/v1/ask/cancel', body });
    return route.fulfill({ json: { planId: body.planId, state: 'cancelled' } });
  });
  return seen;
}

/** Opens Ask, asks a question and confirms its preview: the plan card is on screen and nothing has run. */
export async function openPlanCard(page: Page): Promise<void> {
  await openAsk(page);
  await previewQuestion(page, 'Which accounts share the same device as this one?');
  await askPanel(page).getByRole('button', { name: 'Send' }).click();
  await askPanel(page).getByRole('region', { name: 'Review before running' }).waitFor();
}
