import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { askPlanResponseSchema, parseExtensionRefusal, type AskPlanRunner, type AuditEvent, type ExtensionRequest } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { REFUSAL_SENTENCES } from './refusal/families.js';
import { PLANNED_RATIONALE } from './routes/ask-plan.js';
import { createAskRunRoute } from './routes/ask-run.js';
import { assertReach, runRig, widgetRef, type RigRun } from './testing/leakage-rig.js';

type End = 'blocked' | 'rejected' | 'unsupported' | 'plan';

interface QuestionFixture {
  readonly name: string;
  readonly message: string;
  readonly known?: Readonly<Record<string, string>>;
  readonly reply?: string;
  readonly end: End;
  readonly forbidden: readonly string[];
}
interface EntityTypeFixture {
  readonly name: string;
  readonly message: string;
  readonly known: Readonly<Record<string, { readonly stableId: string; readonly entityType: string }>>;
  readonly placeholder: string;
  readonly forbidden: readonly string[];
}
interface ReplyFixture {
  readonly name: string;
  readonly reply: string;
  readonly end: End;
  readonly family?: string;
  readonly requests: number;
  readonly forbidden: readonly string[];
  /** The reply to the repair call; the same reply again when none is given. */
  readonly repair?: string;
  /** Text the `problems` the repair prompt is given must not hold: paths and codes only, never a value of the reply. */
  readonly neverInProblems?: readonly string[];
}

const FILE = fileURLToPath(new URL('../../../services/api/tests/ask/fixtures/injection.json', import.meta.url));
const fixtures = JSON.parse(readFileSync(FILE, 'utf8')) as {
  readonly questions: readonly QuestionFixture[];
  readonly entityTypes: readonly EntityTypeFixture[];
  readonly typedPlaceholders: readonly { readonly name: string; readonly message: string }[];
  readonly replies: readonly ReplyFixture[];
};

const KNOWN = { 'Acme Corp': [widgetRef('W-100')] };
const ENDS: readonly End[] = ['blocked', 'rejected', 'unsupported', 'plan'];

/** What the code did, read from the run: never from a status word of the fixture. */
function endOf(run: RigRun): End {
  if (run.refusal !== undefined) return 'rejected';
  const last = run.answers.at(-1);
  if (typeof last === 'object' && last !== null && 'blocked' in last) return 'blocked';
  const answer = askPlanResponseSchema.parse(last);
  if (!('plan' in answer)) throw new Error('the route answered no plan and no end this test knows');
  return answer.plan.kind === 'plan' ? 'plan' : 'unsupported';
}

const everything = (run: RigRun): string => JSON.stringify([run.requests, run.answers, run.store.plans, run.events]);
const known = (map: Readonly<Record<string, string>> | undefined) => Object.fromEntries(Object.entries(map ?? {}).map(([text, id]) => [text, [widgetRef(id)]]));

describe('every fixture names its end, and the end is one the suite knows', () => {
  it('has an end of the four for every fixture that has one', () => {
    for (const fixture of [...fixtures.questions, ...fixtures.replies]) expect(ENDS, fixture.name).toContain(fixture.end);
    expect(() => endOf({ answers: [{ nothing: true }], refusal: undefined } as unknown as RigRun)).toThrow();
  });
});

describe('an injection in the question', () => {
  it.each(fixtures.questions.map((fixture) => [fixture.name, fixture] as const))('%s ends as %s, as the code did, and none of its text reaches a request', async (_name, fixture) => {
    const run = await runRig(fixture.message, { known: known(fixture.known), ...(fixture.reply === undefined ? {} : { reply: { kind: 'ok' as const, text: fixture.reply } }) });
    expect(endOf(run)).toBe(fixture.end);
    assertReach(run, fixture.end !== 'blocked');
    for (const text of fixture.forbidden) expect(JSON.stringify(run.requests).toLowerCase(), 'a request holds injected text').not.toContain(text.toLowerCase());
  });
});

describe('an injection at the entity boundary', () => {
  it.each(fixtures.entityTypes.map((fixture) => [fixture.name, fixture] as const))('%s: the request holds the placeholder and none of the text', async (_name, fixture) => {
    const map = Object.fromEntries(Object.entries(fixture.known).map(([text, ref]) => [text, [widgetRef(ref.stableId, ref.entityType)]]));
    const run = await runRig(fixture.message, { known: map, reply: { kind: 'refused' } });
    assertReach(run, true);
    expect(JSON.stringify(run.requests[0]?.parameters.question)).toContain(fixture.placeholder);
    for (const text of fixture.forbidden) expect(JSON.stringify(run.requests).toLowerCase()).not.toContain(text.toLowerCase());
  });

  it.each(fixtures.typedPlaceholders.map((fixture) => [fixture.name, fixture] as const))('%s ends as a route refusal and no request', async (_name, fixture) => {
    const run = await runRig(fixture.message);
    expect(endOf(run)).toBe('rejected');
    expect(parseExtensionRefusal(run.refusal)).toEqual({ code: 'INVALID_REQUEST', reason: 'typed-placeholder' });
    assertReach(run, false);
  });
});

describe('an injection in the model reply', () => {
  it.each(fixtures.replies.map((fixture) => [fixture.name, fixture] as const))('%s ends as stated, with the fixed words of the route and none of the injected text anywhere', async (_name, fixture) => {
    const run = await runRig('what is Acme Corp?', { known: KNOWN, reply: { kind: 'ok', text: fixture.reply }, ...(fixture.repair === undefined ? {} : { repairReply: { kind: 'ok' as const, text: fixture.repair } }) });
    expect(endOf(run)).toBe(fixture.end);
    expect(run.requests).toHaveLength(fixture.requests);
    for (const text of fixture.neverInProblems ?? []) expect(String(run.requests[1]?.parameters.problems), 'the repair call was told a value of the reply').not.toContain(text);
    const last = askPlanResponseSchema.parse(run.answers.at(-1));
    if (!('plan' in last)) throw new Error('no plan');
    if (fixture.end === 'plan' && last.plan.kind === 'plan') expect(last.plan.rationale).toBe(PLANNED_RATIONALE);
    if (fixture.end === 'unsupported' && last.plan.kind === 'unsupported') {
      expect(last.plan.family).toBe(fixture.family);
      expect(last.plan.reason).toBe(REFUSAL_SENTENCES[last.plan.family]);
    }
    // the requests of the repair call echo the previous reply by design; the answer, the stored row and the audit events never hold it
    const placed = JSON.stringify([run.answers, run.store.plans, run.events]).toLowerCase();
    for (const text of fixture.forbidden) expect(placed, 'injected text in an answer, a stored row or an audit event').not.toContain(text.toLowerCase());
  });
});

describe('a plan that an injection let through stays behind the confirm step', () => {
  const MAC = (canonical: string) => createHmac('sha256', 'a-key').update(canonical).digest('hex');
  const planned = fixtures.replies.filter((fixture) => fixture.end === 'plan');

  it('has fixtures that end in a plan, so the cases below are not zero', () => {
    expect(planned.length).toBeGreaterThan(1);
  });

  it.each(planned.map((fixture) => [fixture.name, fixture] as const))('%s: stored as proposed, run by its owner once, and by no one else', async (_name, fixture) => {
    const run = await runRig('what is Acme Corp?', { known: KNOWN, reply: { kind: 'ok', text: fixture.reply }, ...(fixture.repair === undefined ? {} : { repairReply: { kind: 'ok' as const, text: fixture.repair } }) });
    const answer = askPlanResponseSchema.parse(run.answers.at(-1));
    if (!('planId' in answer) || answer.planId === undefined) throw new Error('no plan ID');
    expect(JSON.stringify(answer)).not.toContain('"result"');
    expect(run.store.plans).toHaveLength(1);
    expect(run.store.plans[0]).toMatchObject({ state: 'proposed', userId: 'p', templateId: 'entity' });
    expect(run.store.runs).toEqual([]);

    const calls: unknown[] = [];
    const runner: AskPlanRunner = { run: async (plan) => (calls.push(plan), { status: 'ok', result: { templateId: 'entity', result: { ref: widgetRef('W-100'), display: { title: 'x', type: 'widget' }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } } } }) };
    const route = createAskRunRoute({ plans: () => run.store });
    const request = (principalId: string): ExtensionRequest => ({
      principalId,
      principalRole: 'investigator',
      previewOn: true,
      traceId: 'tr-run',
      audit: { record: async (_event: AuditEvent) => undefined },
      askPlanner: { availability: () => ({ available: true }), plan: () => Promise.reject(new Error('not used')) },
      previewMac: MAC,
      askPlanRunner: () => runner,
      body: { planId: answer.planId },
    });
    expect(parseExtensionRefusal(await route.handler(request('someone-else')).catch((error: unknown) => error))).toEqual({ code: 'NOT_FOUND' });
    expect(calls).toHaveLength(0);
    await route.handler(request('p'));
    expect(calls).toHaveLength(1);
    expect(parseExtensionRefusal(await route.handler(request('p')).catch((error: unknown) => error))).toEqual({ code: 'CONFLICT', reason: 'plan-not-runnable' });
    expect(calls).toHaveLength(1);
  });
});
