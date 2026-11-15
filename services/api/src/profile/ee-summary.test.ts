import { rmSync } from 'node:fs';
import { summaryResponseSchema, type CaseSummarizer, type CaseSummaryInput, type CaseSummaryOutcome } from '@neburyx/contracts';
import { buildSummaryInstructions, createAuditedModelCall, createCaseSummarizer, createEnterpriseExtension, openToken, promptRecordOf, type ModelProvider, type ModelRequest } from '@neburyx/ee-ask';
import { afterAll, describe, expect, it } from 'vitest';
import { LOCAL_IDENTITY } from '../testing/app-store.js';
import { el, exportWebRoot, linkRef, startExportRig, type ExportRigOptions } from '../testing/export-rig.js';

afterAll(() => rmSync(exportWebRoot, { recursive: true, force: true }));

const OK: CaseSummaryOutcome = { status: 'ok', sentences: [{ text: 'Two accounts share a device.', cites: ['n1', 'n2'] }], sent: 'the text sent', model: 'stub-model', calls: 1, summaryToken: 'v1.token' };

function stubSummarizer(outcome: CaseSummaryOutcome | undefined, calls: CaseSummaryInput[], available = true, maxElements = 300): CaseSummarizer {
  return {
    maxElements,
    availability: () => (available ? { available: true } : { available: false, reason: 'the size guard is not set' }),
    summarize: async (input) => (calls.push(input), outcome ?? OK),
  };
}

type Options = Omit<ExportRigOptions, 'extension' | 'caseSummarizer'> & { readonly summarizer?: CaseSummarizer; readonly role?: 'administrator' | 'investigator' | 'viewer'; readonly roleNow?: () => 'administrator' | 'investigator' | 'viewer'; readonly principalId?: () => string; readonly allowed?: () => boolean };

async function appOf(options: Options = {}) {
  const role = options.role ?? 'investigator';
  const rig = await startExportRig({
    ...options,
    extension: createEnterpriseExtension(),
    ...(options.summarizer === undefined ? {} : { caseSummarizer: options.summarizer }),
    principal: () => ({ role: options.roleNow?.() ?? role, ...(options.principalId === undefined ? {} : { id: options.principalId() }) }),
    ...(options.allowed === undefined ? {} : { deny: () => !options.allowed?.() }),
  });
  const investigation = await rig.open();
  const body = { investigationId: investigation.id, sourceId: 'demo', entities: [el('widget', 'W-1'), el('widget', 'W-2')] };
  return { app: rig.app, events: rig.events, rig, body };
}

type Rig = Awaited<ReturnType<typeof appOf>>;
let keyNumber = 0;
const freshKey = (): string => `key-${String(++keyNumber).padStart(16, '0')}`;
const post = (rig: Rig, payload: unknown = rig.body, key: string | null = freshKey()) =>
  rig.app.inject({ method: 'POST', url: '/v1/summary', payload: payload as object, headers: key === null ? {} : { 'idempotency-key': key } });

describe('POST /v1/summary', () => {
  it('answers that the summary is not in this edition when the application has the Community summarizer', async () => {
    const rig = await appOf({});
    const answer = await post(rig);
    expect(answer.statusCode).toBe(422);
    expect(answer.json().error).toMatchObject({ code: 'ASK_UNSUPPORTED' });
    await rig.rig.stop();
  });

  it.each(['administrator', 'investigator'] as const)('drafts for an %s through the summarizer and answers its outcome', async (role) => {
    const calls: CaseSummaryInput[] = [];
    const rig = await appOf({ summarizer: stubSummarizer(undefined, calls), role });
    const answer = await post(rig);
    expect(answer.statusCode).toBe(200);
    expect(summaryResponseSchema.parse(answer.json())).toEqual(OK);
    expect(calls).toHaveLength(1);
    await rig.rig.stop();
  });

  it('refuses a viewer with ACCESS_DENIED and does not call the summarizer', async () => {
    const calls: CaseSummaryInput[] = [];
    const rig = await appOf({ summarizer: stubSummarizer(undefined, calls), role: 'viewer' });
    const answer = await post(rig);
    expect(answer.statusCode).toBe(403);
    expect(answer.json().error).toMatchObject({ code: 'ACCESS_DENIED' });
    expect(calls).toEqual([]);
    await rig.rig.stop();
  });

  it('is refused as every AI route is when the preview is off, audited, without calling the summarizer', async () => {
    const calls: CaseSummaryInput[] = [];
    const rig = await appOf({ summarizer: stubSummarizer(undefined, calls), previewOn: false });
    const answer = await post(rig);
    expect(answer.statusCode).toBe(403);
    expect(answer.json().error).toMatchObject({ code: 'ACCESS_DENIED', details: { reason: 'ai-preview-off' } });
    expect(calls).toEqual([]);
    expect(rig.events.filter((event) => event.action === 'ai.route_refused')).toHaveLength(1);
    await rig.rig.stop();
  });

  it('answers unavailable, without a value in the answer, when the summarizer says it is not available', async () => {
    const calls: CaseSummaryInput[] = [];
    const rig = await appOf({ summarizer: stubSummarizer(undefined, calls, false) });
    const answer = await post(rig);
    expect(answer.statusCode).toBe(422);
    expect(answer.json().error).toMatchObject({ code: 'ASK_UNSUPPORTED' });
    expect(JSON.stringify(answer.json())).not.toContain('size guard');
    expect(calls).toEqual([]);
    await rig.rig.stop();
  });

  it.each<[string, CaseSummaryOutcome]>([
    ['the time limit', { status: 'timeLimit', calls: 3 }],
    ['a format failure', { status: 'failed', kind: 'format', calls: 5 }],
    ['a provider failure', { status: 'failed', kind: 'rate-limited', calls: 1 }],
    ['a provider envelope failure', { status: 'failed', kind: 'bad-reply', calls: 1 }],
  ])('answers %s with the body the contract names and no draft', async (_name, outcome) => {
    const rig = await appOf({ summarizer: stubSummarizer(outcome, []) });
    const answer = await post(rig);
    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toEqual(outcome);
    await rig.rig.stop();
  });

  it.each([
    ['an unknown field', (body: object) => ({ ...body, extra: 1 })],
    ['no investigation', () => ({ sourceId: 'demo' })],
    ['a reference that is not one', (body: object) => ({ ...body, entities: [{ nope: 1 }] })],
  ])('refuses a request with %s as INVALID_REQUEST', async (_name, payload) => {
    const calls: CaseSummaryInput[] = [];
    const rig = await appOf({ summarizer: stubSummarizer(undefined, calls) });
    const answer = await post(rig, payload(rig.body));
    expect(answer.statusCode).toBe(400);
    expect(answer.json().error).toMatchObject({ code: 'INVALID_REQUEST' });
    expect(calls).toEqual([]);
    await rig.rig.stop();
  });
});

describe('POST /v1/summary and its Idempotency-Key', () => {
  it.each([['missing', null], ['too short', 'short'], ['with a space', 'key with a space 1234']])('refuses a key that is %s as INVALID_REQUEST', async (_name, key) => {
    const calls: CaseSummaryInput[] = [];
    const rig = await appOf({ summarizer: stubSummarizer(undefined, calls) });
    const answer = await post(rig, rig.body, key);
    expect(answer.statusCode).toBe(400);
    expect(answer.json().error).toMatchObject({ code: 'INVALID_REQUEST' });
    expect(calls).toEqual([]);
    await rig.rig.stop();
  });

  it('answers the same draft again, marked as a replay, without a second call', async () => {
    const calls: CaseSummaryInput[] = [];
    const rig = await appOf({ summarizer: stubSummarizer(undefined, calls) });
    const key = freshKey();
    const first = await post(rig, rig.body, key);
    const second = await post(rig, rig.body, key);
    expect(second.json()).toEqual(first.json());
    expect(first.headers['idempotent-replay']).toBeUndefined();
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(calls).toHaveLength(1);
    await rig.rig.stop();
  });

  it('answers CONFLICT to a second call with the key while the first is still running', async () => {
    const calls: CaseSummaryInput[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const slow: CaseSummarizer = { maxElements: 300, availability: () => ({ available: true }), summarize: async (input) => (calls.push(input), await held, OK) };
    const rig = await appOf({ summarizer: slow });
    const key = freshKey();
    const first = post(rig, rig.body, key);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await post(rig, rig.body, key);
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toMatchObject({ code: 'CONFLICT' });
    release();
    expect((await first).statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    await rig.rig.stop();
  });

  it('answers CONFLICT to the key sent with another body', async () => {
    const rig = await appOf({ summarizer: stubSummarizer(undefined, []) });
    const key = freshKey();
    await post(rig, rig.body, key);
    const other = await post(rig, { ...rig.body, entities: [el('widget', 'W-1')] }, key);
    expect(other.statusCode).toBe(409);
    await rig.rig.stop();
  });

  it('does not serve one person the draft of another who used the same key (the investigation is not theirs)', async () => {
    const calls: CaseSummaryInput[] = [];
    let person = 'person-1';
    const rig = await appOf({ summarizer: stubSummarizer(undefined, calls), principalId: () => person });
    const key = freshKey();
    await post(rig, rig.body, key);
    person = 'person-2';
    const second = await post(rig, rig.body, key);
    expect(second.headers['idempotent-replay']).toBeUndefined();
    expect(second.statusCode).toBe(404);
    expect(calls).toHaveLength(1);
    await rig.rig.stop();
  });

  it('refuses a replay when the access has been revoked since', async () => {
    let allowed = true;
    const rig = await appOf({ summarizer: stubSummarizer(undefined, []), allowed: () => allowed });
    const key = freshKey();
    await post(rig, rig.body, key);
    allowed = false;
    const replay = await post(rig, rig.body, key);
    expect(replay.statusCode).toBe(403);
    await rig.rig.stop();
  });

  it('does not return the stored answer when the policy version has changed', async () => {
    let version = 'v1';
    const rig = await appOf({ summarizer: stubSummarizer(undefined, []), policyVersion: () => version });
    const key = freshKey();
    await post(rig, rig.body, key);
    version = 'v2';
    const replay = await post(rig, rig.body, key);
    expect(replay.statusCode).toBe(409);
    expect(replay.headers['idempotent-replay']).toBeUndefined();
    await rig.rig.stop();
  });

  it('runs again for a retry after a server error, and stores a refusal for replay', async () => {
    let attempts = 0;
    const flaky: CaseSummarizer = { maxElements: 300, availability: () => ({ available: true }), summarize: async () => (++attempts === 1 ? Promise.reject(new Error('boom')) : OK) };
    const rig = await appOf({ summarizer: flaky });
    const key = freshKey();
    expect((await post(rig, rig.body, key)).statusCode).toBe(500);
    expect((await post(rig, rig.body, key)).statusCode).toBe(200);
    expect(attempts).toBe(2);
    await rig.rig.stop();
  });

  it('does not require a key when the preview is off, and refuses as every AI route is', async () => {
    const rig = await appOf({ summarizer: stubSummarizer(undefined, []), previewOn: false });
    const answer = await post(rig, rig.body, null);
    expect(answer.statusCode).toBe(403);
    await rig.rig.stop();
  });
});

const loadCalls = (rig: Rig) => rig.rig.executor.calls.filter((call) => call.templateId === 'entity-load-many' || call.templateId === 'edge-load-many');

describe('POST /v1/summary and the re-read of the view', () => {
  it('answers tooLarge with the count and the cap before any read and without the summarizer', async () => {
    const calls: CaseSummaryInput[] = [];
    const rig = await appOf({ summarizer: stubSummarizer(undefined, calls, true, 3) });
    const many = { ...rig.body, entities: [el('widget', 'W-1'), el('widget', 'W-2'), el('gadget', 'GT-1')], edges: [linkRef('L-1')] };
    const answer = await post(rig, many);
    expect(answer.json()).toEqual({ status: 'tooLarge', limit: 'elements', elements: 4, cap: 3 });
    expect(loadCalls(rig)).toEqual([]);
    expect(calls).toEqual([]);
    await rig.rig.stop();
  });

  it('gives the summarizer what the gate returned for the references, never the request content', async () => {
    const calls: CaseSummaryInput[] = [];
    const rig = await appOf({ summarizer: stubSummarizer(undefined, calls), links: ['L-1'] });
    const answer = await post(rig, { ...rig.body, edges: [linkRef('L-1')] });
    expect(answer.statusCode).toBe(200);
    const [input] = calls;
    expect(input?.reading.nodes.map((node) => node.ref.stableId).sort()).toEqual(['W-1', 'W-2']);
    expect(input?.reading.edges).toHaveLength(1);
    expect(input?.reading.missing).toEqual({ entities: [], edges: [] });
    expect(loadCalls(rig).length).toBeGreaterThan(0);
    await rig.rig.stop();
  });

  it('applies the mask of the request', async () => {
    const seen: string[] = [];
    const record: CaseSummarizer = { ...stubSummarizer(undefined, []), summarize: async (input) => (seen.push(JSON.stringify(input.reading)), OK) };
    const rig = await appOf({ summarizer: record });
    await post(rig, { ...rig.body, mask: false });
    await post(rig, { ...rig.body, mask: true });
    expect(seen[0]).toContain('Ana Silva');
    expect(seen[1]).not.toContain('Ana Silva');
    await rig.rig.stop();
  });

  it('passes on the references the gate could not resolve, with no cause', async () => {
    const calls: CaseSummaryInput[] = [];
    const rig = await appOf({ summarizer: stubSummarizer(undefined, calls), widgets: ['W-1'] });
    await post(rig, { ...rig.body, entities: [el('widget', 'W-1'), el('widget', 'W-9')] });
    expect(calls[0]?.reading.missing.entities.map((ref) => ref.stableId)).toEqual(['W-9']);
    await rig.rig.stop();
  });

  it('reads more references than one read takes in as many reads as they need', async () => {
    const calls: CaseSummaryInput[] = [];
    const rig = await appOf({ summarizer: stubSummarizer(undefined, calls), widgets: () => true });
    const entities = Array.from({ length: 250 }, (_unused, index) => el('widget', `W-${index}`));
    await post(rig, { ...rig.body, entities });
    expect(loadCalls(rig).length).toBeGreaterThanOrEqual(3);
    expect(calls[0]?.reading.nodes).toHaveLength(250);
    await rig.rig.stop();
  });

  it.each([
    ['an investigation that is not for the source', (body: { investigationId: string }) => ({ ...body, sourceId: 'elsewhere' })],
    ['an investigation that does not exist', (body: object) => ({ ...body, investigationId: '0192f000-0000-7000-8000-00000000dead' })],
    ['an id that is not an investigation id', (body: object) => ({ ...body, investigationId: 'inv-1' })],
  ])('answers NOT_FOUND for %s and does not call the summarizer', async (_name, change) => {
    const calls: CaseSummaryInput[] = [];
    const rig = await appOf({ summarizer: stubSummarizer(undefined, calls) });
    const answer = await post(rig, change(rig.body));
    expect(answer.statusCode).toBe(404);
    expect(answer.json().error).toMatchObject({ code: 'NOT_FOUND' });
    expect(calls).toEqual([]);
    await rig.rig.stop();
  });

  it('answers NOT_FOUND for a source the person may not read', async () => {
    const calls: CaseSummaryInput[] = [];
    let allowed = true;
    const rig = await appOf({ summarizer: stubSummarizer(undefined, calls), allowed: () => allowed });
    allowed = false;
    const answer = await post(rig);
    expect(answer.statusCode).toBe(404);
    expect(calls).toEqual([]);
    await rig.rig.stop();
  });

  it.each([
    ['a source that is down', { status: 'unavailable', reason: 'unreachable' } as const, 503],
    ['a read that timed out', { status: 'timeout' } as const, 504],
  ])('answers the gate\'s own error for %s and does not call the summarizer', async (_name, outcome, status) => {
    const calls: CaseSummaryInput[] = [];
    const rig = await appOf({ summarizer: stubSummarizer(undefined, calls), answer: (call) => (call.templateId === 'entity-load-many' ? outcome : undefined) });
    const answer = await post(rig);
    expect(answer.statusCode).toBe(status);
    expect(calls).toEqual([]);
    await rig.rig.stop();
  });
});

describe('POST /v1/summary and its closing event', () => {
  const closing = (rig: Rig) => rig.events.filter((event) => event.action === 'ai.case-summary.closed');

  it('records exactly one closing event when the element cap is passed, holding counts and a hash and no reference', async () => {
    const rig = await appOf({ summarizer: stubSummarizer(undefined, [], true, 1) });
    await post(rig);
    expect(closing(rig)).toHaveLength(1);
    expect(closing(rig)[0]).toMatchObject({ result: 'refused', detail: { summary: { elements: 2, calls: 0, outcome: 'tooLarge' } } });
    expect(JSON.stringify(closing(rig))).not.toContain('W-1');
    await rig.rig.stop();
  });

  it('records exactly one closing event when the summarizer is not available', async () => {
    const rig = await appOf({ summarizer: stubSummarizer(undefined, [], false) });
    await post(rig);
    expect(closing(rig)).toHaveLength(1);
    expect(closing(rig)[0]).toMatchObject({ result: 'failed', detail: { summary: { outcome: 'unavailable', calls: 0 } } });
    await rig.rig.stop();
  });

  it('fails closed with AUDIT_UNAVAILABLE when the closing event of a refusal cannot be written', async () => {
    const rig = await appOf({ summarizer: stubSummarizer(undefined, [], true, 1), failAudit: (action) => action === 'ai.case-summary.closed' });
    const answer = await post(rig);
    expect(answer.statusCode).toBe(503);
    expect(answer.json().error).toMatchObject({ code: 'AUDIT_UNAVAILABLE' });
    await rig.rig.stop();
  });
});

describe('POST /v1/summary completed, with the real application, the real gate and a stub provider', () => {
  const keys = { current: { kid: 'abcd1234', bytes: Buffer.alloc(32, 9) } };

  function realSummarizer(received: ModelRequest[]) {
    const provider: ModelProvider = {
      complete: async (request) => (received.push(request), { status: 'ok', text: JSON.stringify({ sentences: [{ text: 'Two widgets are listed.', cites: ['n1', 'n2'] }] }), usage: { kind: 'unknown' }, model: 'm', prompt: promptRecordOf(request) }),
    };
    const model = createAuditedModelCall({ provider, configuration: { model: 'claude-sonnet-5-5' }, sink: { record: async () => undefined } });
    return createCaseSummarizer({
      settings: { model: 'claude-sonnet-5-5', timeoutMs: 60_000, totalTimeoutMs: 180_000, maxCalls: 5, maxElements: 300, maxInputTokens: 100_000, retentionDays: 30 },
      instructions: buildSummaryInstructions('PROMPT', 'TYPOLOGY'),
      model: () => model,
      audit: () => ({ record: async () => undefined }),
      tokenKeys: () => keys,
      availability: () => ({ available: true }),
    });
  }

  it('sends the masked, assembled text to the provider and answers the sentences, the text sent and a token that opens for this person', async () => {
    const received: ModelRequest[] = [];
    const rig = await appOf({ summarizer: realSummarizer(received), widgets: ['W-1', 'W-2'] });
    const answer = await post(rig, { ...rig.body, mask: true });
    expect(answer.statusCode).toBe(200);
    const body = summaryResponseSchema.parse(answer.json());
    expect(body.status).toBe('ok');
    if (body.status !== 'ok') return;
    expect(received).toHaveLength(1);
    expect(received[0]?.values).toBe(body.sent);
    expect(body.sent).toContain('n1 | "widget"');
    expect(body.sent).not.toContain('Ana Silva');
    expect(received[0]?.instructions).toContain('# Reply format');
    expect(body.sentences).toEqual([{ text: 'Two widgets are listed.', cites: ['n1', 'n2'] }]);
    const opened = openToken(keys, body.summaryToken, { investigationId: rig.body.investigationId, actorId: LOCAL_IDENTITY.principal.id, policyVersion: 'none', now: Date.now() });
    expect(opened.ok && opened.payload.inputRefs.map((entry) => entry.key)).toEqual(['n1', 'n2']);
    await rig.rig.stop();
  });

  it('sends the names and values the person sees when the mask is off, and records that property values were sent', async () => {
    const received: ModelRequest[] = [];
    const rig = await appOf({ summarizer: realSummarizer(received) });
    const answer = await post(rig, { ...rig.body, mask: false });
    const body = summaryResponseSchema.parse(answer.json());
    expect(body.status === 'ok' && body.sent).toContain('Ana Silva');
    const token = body.status === 'ok' ? body.summaryToken : '';
    const opened = openToken(keys, token, { investigationId: rig.body.investigationId, actorId: LOCAL_IDENTITY.principal.id, policyVersion: 'none', now: Date.now() });
    expect(opened.ok && opened.payload.propertyValuesSent).toBe(true);
    await rig.rig.stop();
  });
});

describe('POST /v1/summary: a replay is authorized like a new call, and a failure is not kept', () => {
  it('refuses a replay when the person has become a viewer, and returns nothing of the draft', async () => {
    let role: 'investigator' | 'viewer' = 'investigator';
    const calls: CaseSummaryInput[] = [];
    const rig = await appOf({ summarizer: stubSummarizer(undefined, calls), roleNow: () => role });
    const key = freshKey();
    await post(rig, rig.body, key);
    role = 'viewer';
    const replay = await post(rig, rig.body, key);
    expect(replay.statusCode).toBe(403);
    expect(JSON.stringify(replay.json())).not.toContain('Two accounts');
    expect(calls).toHaveLength(1);
    await rig.rig.stop();
  });

  it('refuses a replay when the investigation is gone or the summary is no longer available', async () => {
    let available = true;
    const summarizer: CaseSummarizer = { maxElements: 300, availability: () => (available ? { available: true } : { available: false, reason: 'x' }), summarize: async () => OK };
    const rig = await appOf({ summarizer });
    const key = freshKey();
    await post(rig, rig.body, key);
    available = false;
    expect((await post(rig, rig.body, key)).statusCode).toBe(403);
    available = true;
    const [row] = rig.rig.store.investigations;
    if (row === undefined) throw new Error('no investigation');
    rig.rig.store.investigations[0] = { ...row, ownerId: 'someone-else' };
    expect((await post(rig, rig.body, key)).statusCode).toBe(403);
    await rig.rig.stop();
  });

  it.each([
    ['a provider failure', { status: 'failed', kind: 'unreachable', calls: 1 } as CaseSummaryOutcome],
    ['the time limit', { status: 'timeLimit', calls: 2 } as CaseSummaryOutcome],
  ])('runs again for a retry with the same key after %s', async (_name, failure) => {
    let attempts = 0;
    const calls: CaseSummaryInput[] = [];
    const flaky: CaseSummarizer = { maxElements: 300, availability: () => ({ available: true }), summarize: async (input) => (calls.push(input), ++attempts === 1 ? failure : OK) };
    const rig = await appOf({ summarizer: flaky });
    const key = freshKey();
    expect((await post(rig, rig.body, key)).json()).toEqual(failure);
    const second = await post(rig, rig.body, key);
    expect(second.json()).toEqual(OK);
    expect(second.headers['idempotent-replay']).toBeUndefined();
    expect(calls).toHaveLength(2);
    await rig.rig.stop();
  });

  it('keeps a draft and a refusal for replay', async () => {
    const calls: CaseSummaryInput[] = [];
    const rig = await appOf({ summarizer: stubSummarizer({ status: 'tooLarge', limit: 'text', estimatedTokens: 9, cap: 5 }, calls) });
    const key = freshKey();
    await post(rig, rig.body, key);
    expect((await post(rig, rig.body, key)).headers['idempotent-replay']).toBe('true');
    expect(calls).toHaveLength(1);
    await rig.rig.stop();
  });

  it('refuses a query string, and does not replay one request for another that differs only by it', async () => {
    const calls: CaseSummaryInput[] = [];
    const rig = await appOf({ summarizer: stubSummarizer(undefined, calls) });
    const key = freshKey();
    for (const url of ['/v1/summary?x=1', '/v1/summary??x=1']) {
      const withQuery = await rig.app.inject({ method: 'POST', url, payload: rig.body, headers: { 'idempotency-key': key } });
      expect(withQuery.statusCode, url).toBe(400);
    }
    expect(calls).toEqual([]);
    expect((await post(rig, rig.body, key)).statusCode).toBe(200);
    await rig.rig.stop();
  });
});

describe('POST /v1/summary and a source that changed', () => {
  it.each([
    ['repointed', { sourceIdentityHash: 'another-database' }],
    ['removed', { sourceId: 'gone' }],
  ] as const)('is refused as source-changed (%s), reads nothing and does not call the summarizer', async (sourceState, change) => {
    const calls: CaseSummaryInput[] = [];
    const rig = await appOf({ summarizer: stubSummarizer(undefined, calls) });
    const [row] = rig.rig.store.investigations;
    if (row === undefined) throw new Error('no investigation');
    rig.rig.store.investigations[0] = { ...row, ...change };
    const reads = rig.rig.executor.calls.length;
    const answer = await post(rig, sourceState === 'removed' ? { ...rig.body, sourceId: 'gone' } : rig.body);
    expect([409, 404]).toContain(answer.statusCode);
    if (sourceState === 'repointed') expect(answer.json().error).toMatchObject({ code: 'CONFLICT', details: { reason: 'source-changed', sourceState } });
    expect(rig.rig.executor.calls.length).toBe(reads);
    expect(calls).toEqual([]);
    await rig.rig.stop();
  });
});

describe('POST /v1/summary and the closing event of a click that fails', () => {
  const closing = (rig: Rig) => rig.events.filter((event) => event.action === 'ai.case-summary.closed');

  it('records one closing event for a source that is down and keeps the gate error', async () => {
    const rig = await appOf({ summarizer: stubSummarizer(undefined, []), answer: (call) => (call.templateId === 'entity-load-many' ? { status: 'unavailable', reason: 'unreachable' } : undefined) });
    const answer = await post(rig);
    expect(answer.statusCode).toBe(503);
    expect(closing(rig)).toHaveLength(1);
    expect(closing(rig)[0]).toMatchObject({ result: 'failed', detail: { summary: { outcome: 'read-failed', calls: 0 } } });
    await rig.rig.stop();
  });

  it('records one closing event when the summarizer throws, and keeps the failure', async () => {
    const boom: CaseSummarizer = { maxElements: 300, availability: () => ({ available: true }), summarize: async () => Promise.reject(new Error('boom')) };
    const rig = await appOf({ summarizer: boom });
    const answer = await post(rig);
    expect(answer.statusCode).toBe(500);
    expect(closing(rig)).toHaveLength(1);
    expect(closing(rig)[0]).toMatchObject({ detail: { summary: { outcome: 'error' } } });
    await rig.rig.stop();
  });

  it('keeps the original failure when the closing event of a failure cannot be written', async () => {
    const rig = await appOf({ summarizer: stubSummarizer(undefined, []), failAudit: (action) => action === 'ai.case-summary.closed', answer: (call) => (call.templateId === 'entity-load-many' ? { status: 'unavailable', reason: 'unreachable' } : undefined) });
    expect((await post(rig)).statusCode).toBe(503);
    expect(closing(rig)).toHaveLength(0);
    await rig.rig.stop();
  });

  it('leaves a request id that is not a UUID out of the closing event instead of refusing the click', async () => {
    const rig = await appOf({ summarizer: stubSummarizer(undefined, [], false) });
    await post(rig, { ...rig.body, investigationId: 'not-a-uuid' });
    expect(closing(rig)).toHaveLength(1);
    expect(closing(rig)[0]?.investigationId).toBeUndefined();
    const real = await appOf({ summarizer: stubSummarizer(undefined, [], false) });
    await post(real);
    expect(closing(real)[0]?.investigationId).toBe(real.body.investigationId);
    await rig.rig.stop();
    await real.rig.stop();
  });
});
