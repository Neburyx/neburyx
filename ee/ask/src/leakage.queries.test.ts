import { askPlanResponseSchema, type ExtensionRoute } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { PLANNED_RATIONALE } from './routes/ask-plan.js';
import { baselineRequest, leakyBuilder, runRig, widgetRef } from './testing/leakage-rig.js';
import { QUERY_PATTERNS, queryTextIn } from './testing/query-patterns.js';

const KNOWN = { 'Acme Corp': [widgetRef('W-100')] };
const PLAN = (rationale: string) => JSON.stringify({ kind: 'plan', templateId: 'entity', templateVersion: 1, params: { ref: { entityType: 'widget', stableId: '‹widget#1›' } }, rationale });

describe('the query patterns', () => {
  it.each(QUERY_PATTERNS.map((entry) => [entry.name, entry] as const))('match a sample of %s', (_name, entry) => {
    expect(entry.pattern.test(entry.sample)).toBe(true);
  });

  it('match nothing of the catalog, the vocabulary and the prompt text, as a whole and word by word', async () => {
    const baseline = await baselineRequest();
    expect(queryTextIn(baseline)).toEqual([]);
    for (const word of new Set(baseline.split(/\s+/))) expect(queryTextIn(word), word).toEqual([]);
  });
});

describe('the requests the provider receives', () => {
  it('hold no query text in any rig run, and the rig itself refuses a run whose request does', async () => {
    const run = await runRig('what is Acme Corp?', { known: KNOWN, reply: { kind: 'ok', text: PLAN('x') } });
    expect(run.requests).toHaveLength(1);
    await expect(runRig('what is Acme Corp?', { known: KNOWN, reply: { kind: 'ok', text: PLAN('x') }, wrapBuilder: leakyBuilder('MATCH (n) RETURN n') })).rejects.toThrow(/request 1 holds query text/);
  });

  it('echo the previous reply of the model in the repair prompt, exactly, and only there, so a reply with a query makes no request that is refused', async () => {
    const reply = 'MATCH (n) RETURN n';
    const run = await runRig('what is Acme Corp?', { known: KNOWN, reply: { kind: 'ok', text: reply } });
    expect(run.requests.map((request) => request.promptId)).toEqual(['ask.plan', 'ask.plan.repair']);
    expect(run.requests[1]?.parameters.reply).toBe(reply);
    expect(JSON.stringify(run.requests[0])).not.toContain('MATCH (n)');
    expect(JSON.stringify({ ...run.requests[1], parameters: { ...run.requests[1]?.parameters, reply: '' } })).not.toContain('MATCH (n)');
  });
});

describe('the answer of the plan route, the stored row and the audit events', () => {
  it('hold no query text when the model puts one in the rationale of a valid plan', async () => {
    const run = await runRig('what is Acme Corp?', { known: KNOWN, reply: { kind: 'ok', text: PLAN('MATCH (n) RETURN n; DROP DATABASE x') } });
    const answer = askPlanResponseSchema.parse(run.answers.at(-1));
    expect('plan' in answer && answer.plan.kind === 'plan' ? answer.plan.rationale : undefined).toBe(PLANNED_RATIONALE);
    expect(queryTextIn(JSON.stringify([run.answers, run.store.plans, run.events]))).toEqual([]);
  });

  it('are caught by the same check when a route double passes the model’s rationale through', async () => {
    const modelRationale = 'MATCH (n) RETURN n; DROP DATABASE x';
    const passingThrough = (route: ExtensionRoute): ExtensionRoute => ({
      ...route,
      handler: async (request) => {
        const answer = await route.handler(request);
        return typeof answer === 'object' && answer !== null && 'plan' in answer && typeof answer.plan === 'object' && answer.plan !== null && 'rationale' in answer.plan ? { ...answer, plan: { ...answer.plan, rationale: modelRationale } } : answer;
      },
    });
    const run = await runRig('what is Acme Corp?', { known: KNOWN, reply: { kind: 'ok', text: PLAN(modelRationale) }, wrapRoute: passingThrough });
    expect(queryTextIn(JSON.stringify(run.answers))).not.toEqual([]);
  });
});

describe('a typed personal value', () => {
  const VIEW = { types: [{ name: 'widget', kind: 'entity' as const, properties: [{ name: 'email', pii: true }] }] };
  const EMAIL = 'zorvath.quillan@mail.example.test';

  it('stays a placeholder in the request, which carries no property value at all, and the audit event of the call names no personal property sent', async () => {
    const run = await runRig(`what is ${EMAIL}?`, { view: VIEW, known: { [EMAIL]: [widgetRef('W-300')] }, reply: { kind: 'refused' } });
    expect(JSON.stringify(run.requests)).not.toContain('zorvath');
    expect(JSON.stringify(run.requests[0]?.parameters.question)).toContain('‹widget#1›');
    expect(run.events).toHaveLength(1);
    expect(JSON.stringify(run.events)).not.toContain('piiPropertiesSent');
  });

  it('stays a value placeholder when it is used as a search value: the request holds the placeholder, and the value is in neither the request nor the plan the model gave', async () => {
    const message = `which widgets have ${EMAIL}`;
    const start = message.indexOf(EMAIL);
    const reply = JSON.stringify({ kind: 'plan', templateId: 'search', templateVersion: 1, params: { entityTypes: ['widget'], text: '‹value#1›' }, rationale: 'x' });
    const run = await runRig(message, { view: VIEW, resolutions: [{ start, end: start + EMAIL.length, value: true }], reply: { kind: 'ok', text: reply } });
    expect(run.requests).toHaveLength(1);
    expect(JSON.stringify(run.requests[0]?.parameters.question)).toContain('‹value#1›');
    expect(JSON.stringify(run.requests)).not.toContain('zorvath');
    const answer = askPlanResponseSchema.parse(run.answers.at(-1));
    // the model's plan was accepted: the answer is a plan of the search template, and the value is in no audit event
    expect('plan' in answer ? [answer.plan.kind, 'templateId' in answer.plan ? answer.plan.templateId : undefined] : undefined).toEqual(['plan', 'search']);
    expect(JSON.stringify(run.events)).not.toContain('zorvath');
    // what the route stores after the value is turned back: the typed text of the search, which the store removes when the plan is run, cancelled or expires
    expect(JSON.stringify(run.store.plans)).toContain(EMAIL);
  });
});
