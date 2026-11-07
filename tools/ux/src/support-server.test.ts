import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { investigationListResponseSchema, investigationResponseSchema, meResponseSchema, openInvestigationResponseSchema, searchResultSchema, sourceProfileSchema, sourcesResponseSchema, sourceTestReportSchema } from '@neburyx/contracts';
import { createSupportServer } from './support-server.ts';

const committed: unknown = JSON.parse(readFileSync(new URL('../fixtures/profile.json', import.meta.url), 'utf8'));

function baseOf(server: Server): string {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server is not listening on a port');
  return `http://127.0.0.1:${address.port}`;
}

let folder = '';
let closing: (() => Promise<void>) | undefined;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'ux-support-'));
  writeFileSync(join(folder, 'index.html'), '<!doctype html><title>app</title>');
  mkdirSync(join(folder, 'assets'));
  writeFileSync(join(folder, 'assets', 'app.js'), 'export {};');
});

afterEach(async () => {
  vi.useRealTimers();
  await closing?.();
  closing = undefined;
  rmSync(folder, { recursive: true, force: true });
});

async function start(): Promise<string> {
  const server = createSupportServer({ root: folder, profile: { sourceId: 'demo' } });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  closing = () => new Promise<void>((done) => void server.close(() => done()));
  return baseOf(server);
}

describe('the support server', () => {
  it('answers an unknown API path with 404 and a body, and a method other than GET with 405', async () => {
    const base = await start();
    for (const path of ['/v1/nothing', '/v1/sources/other/profile', '/v1']) {
      const reply = await fetch(base + path);
      expect(reply.status, path).toBe(404);
      expect(await reply.json()).toEqual({ error: { code: 'NOT_FOUND' } });
    }
    expect((await fetch(`${base}/v1/me`, { method: 'POST' })).status).toBe(405);
  });

  it('answers the reads the pages make with synthetic bodies that name one source', async () => {
    const base = await start();
    expect(await (await fetch(`${base}/v1/me`)).json()).toMatchObject({ edition: 'community', identityMode: 'none', principal: { role: 'administrator' } });
    expect(await (await fetch(`${base}/v1/sources`)).json()).toMatchObject({ items: [{ id: 'demo', synthetic: true, readOnly: true, state: 'connected' }], nextCursor: null });
    expect(await (await fetch(`${base}/v1/sources/demo/profile`)).json()).toEqual({ sourceId: 'demo' });
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
  });

  it('serves a built file with its type, an application path as index.html, and a missing file as 404', async () => {
    const base = await start();
    const asset = await fetch(`${base}/assets/app.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toContain('text/javascript');
    for (const path of ['/dev/frame-sample', '/explore', '/']) {
      const page = await fetch(base + path);
      expect(page.status, path).toBe(200);
      expect(await page.text()).toContain('<title>app</title>');
    }
    expect(await (await fetch(`${base}/assets/missing.js`)).text()).toBe('<!doctype html><title>app</title>');
  });

  it('does not serve a file outside the folder', async () => {
    const base = await start();
    const reply = await fetch(`${base}/..%2f..%2fetc%2fhosts`);
    expect(await reply.text()).toBe('<!doctype html><title>app</title>');
  });

  it('answers bodies the web app accepts: the contracts parse them, and the profile is the committed one', async () => {
    const profile = sourceProfileSchema.parse(committed);
    const server = createSupportServer({ root: folder, profile });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    closing = () => new Promise<void>((done) => void server.close(() => done()));
    const base = baseOf(server);
    expect(meResponseSchema.safeParse(await (await fetch(`${base}/v1/me`)).json()).success).toBe(true);
    const sources = sourcesResponseSchema.parse(await (await fetch(`${base}/v1/sources`)).json());
    expect(sources.items.map((item) => item.id)).toEqual([profile.sourceId]);
    expect(sourceProfileSchema.parse(await (await fetch(`${base}/v1/sources/${profile.sourceId}/profile`)).json())).toEqual(profile);
  });
});

describe('the investigations the support server holds', () => {
  async function startWithTypes(): Promise<string> {
    const server = createSupportServer({ root: folder, profile: { sourceId: 'demo', entityTypes: [{ type: 'thing' }] } });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    closing = () => new Promise<void>((done) => void server.close(() => done()));
    return baseOf(server);
  }
  const open = (base: string, body: unknown) => fetch(`${base}/v1/investigations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const request = (extra: Record<string, unknown> = {}) => ({ sourceId: 'demo', entity: { sourceId: 'demo', entityType: 'thing', stableId: 'T-1' }, ...extra });

  it('forgets every investigation opened when a spec asks, and lists none afterwards', async () => {
    const base = await startWithTypes();
    await open(base, request());
    const count = async (): Promise<number> => investigationListResponseSchema.parse(await (await fetch(`${base}/v1/investigations`)).json()).counts.investigations.value;
    expect(await count()).toBe(1);
    expect((await fetch(`${base}/__support/forget-investigations`, { method: 'POST' })).status).toBe(200);
    expect(await count()).toBe(0);
  });

  it('lists the investigations opened, the most recently created first, five unless asked, with whether more exist, and refuses a query that is not the contract\'s', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-11-05T12:00:00.000Z') });
    const base = await startWithTypes();
    const list = async (query = '') => investigationListResponseSchema.parse(await (await fetch(`${base}/v1/investigations${query}`)).json());
    expect(await list()).toEqual({ items: [], hasMore: false, counts: { investigations: { value: 0, quality: 'exact', scope: 'investigations' }, sources: { value: 0, quality: 'exact', scope: 'investigation-sources' }, savedViews: { count: { value: 0, quality: 'exact', scope: 'named-views' }, lastEditedAt: null } } });
    for (const id of ['T-1', 'T-2', 'T-3', 'T-4', 'T-5', 'T-6']) {
      vi.advanceTimersByTime(1000);
      await open(base, request({ entity: { sourceId: 'demo', entityType: 'thing', stableId: id } }));
    }
    const first = await list('?limit=5&sort=lastEdited');
    expect(first.items.map((item) => item.startingEntity?.stableId)).toEqual(['T-6', 'T-5', 'T-4', 'T-3', 'T-2']);
    expect(first).toMatchObject({ hasMore: true, counts: { investigations: { value: 6 }, sources: { value: 1 } } });
    expect(first.items[0]).toMatchObject({ sourceAlias: 'demo', save: { state: 'unsaved', savedAt: null }, sourceState: 'available' });
    expect(await list()).toEqual(first);
    expect((await list('?limit=25')).hasMore).toBe(false);
    expect((await list('?limit=1')).counts.investigations.value).toBe(6);
    for (const query of ['?limit=0', '?limit=26', '?sort=name', '?other=1', '?limit=5&limit=6']) expect((await fetch(`${base}/v1/investigations${query}`)).status).toBe(400);
  });

  it('puts the larger id first between investigations created at the same time', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-11-05T12:00:00.000Z') });
    const base = await startWithTypes();
    const ids: string[] = [];
    for (const stableId of ['T-1', 'T-2', 'T-3', 'T-4']) ids.push(openInvestigationResponseSchema.parse(await (await open(base, request({ entity: { sourceId: 'demo', entityType: 'thing', stableId } }))).json()).investigation.id);
    const listed = investigationListResponseSchema.parse(await (await fetch(`${base}/v1/investigations`)).json());
    expect(listed.items.map((item) => item.id)).toEqual([...ids].sort().reverse());
  });

  it('opens an investigation, reads it back, and reads the entity', async () => {
    const base = await startWithTypes();
    const reply = await open(base, request());
    expect(reply.status).toBe(201);
    const opened = openInvestigationResponseSchema.parse(await reply.json());
    expect(opened).toMatchObject({ created: true, entity: { ref: { sourceId: 'demo', entityType: 'thing', stableId: 'T-1' } } });
    expect(investigationResponseSchema.parse(await (await fetch(`${base}/v1/investigations/${opened.investigation.id}`)).json())).toMatchObject({ investigation: { id: opened.investigation.id, sourceState: 'available' } });
    expect(await (await fetch(`${base}/v1/entities/demo/thing/T-1`)).json()).toMatchObject({ ref: { stableId: 'T-1' } });
  });

  it('resumes the investigation of the same case reference, and makes a new one without it', async () => {
    const base = await startWithTypes();
    const first = openInvestigationResponseSchema.parse(await (await open(base, request({ caseRef: 'CASE-1' }))).json());
    const again = await open(base, request({ caseRef: 'CASE-1' }));
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ created: false, investigation: { id: first.investigation.id } });
    const a = openInvestigationResponseSchema.parse(await (await open(base, request())).json());
    const b = openInvestigationResponseSchema.parse(await (await open(base, request())).json());
    expect(a.investigation.id).not.toBe(b.investigation.id);
  });

  it('answers a new investigation with a case reference that marks it repointed as available with its entity, and the same one resumed and read back as repointed without an entity', async () => {
    const base = await startWithTypes();
    const created = await open(base, request({ caseRef: 'repointed-1' }));
    expect(created.status).toBe(201);
    const opened = openInvestigationResponseSchema.parse(await created.json());
    expect(opened).toMatchObject({ created: true, investigation: { sourceState: 'available' }, entity: { ref: { stableId: 'T-1' } } });
    const resumed = await open(base, request({ caseRef: 'repointed-1' }));
    expect(resumed.status).toBe(200);
    const again = openInvestigationResponseSchema.parse(await resumed.json());
    expect(again).toMatchObject({ created: false, investigation: { sourceState: 'repointed' } });
    expect(again).not.toHaveProperty('entity');
    expect(investigationResponseSchema.parse(await (await fetch(`${base}/v1/investigations/${opened.investigation.id}`)).json()).investigation.sourceState).toBe('repointed');
  });

  describe('with a second source', () => {
    const second = { sourceId: 'other', entityTypes: [{ type: 'thing' }, { type: 'extra' }] };
    async function startTwo(): Promise<string> {
      const server = createSupportServer({ root: folder, profile: { sourceId: 'demo', entityTypes: [{ type: 'thing' }] }, otherProfiles: [second] });
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      closing = () => new Promise<void>((done) => void server.close(() => done()));
      return baseOf(server);
    }
    const openIn = (base: string, sourceId: string, extra: Record<string, unknown> = {}, entityType = 'thing') => open(base, { sourceId, entity: { sourceId, entityType, stableId: 'T-1' }, ...extra });

    it('lists both sources, answers each one\'s profile, and reads an entity under the source in its path only', async () => {
      const base = await startTwo();
      expect(sourcesResponseSchema.parse(await (await fetch(`${base}/v1/sources`)).json()).items.map((item) => item.id)).toEqual(['demo', 'other']);
      expect(meResponseSchema.parse(await (await fetch(`${base}/v1/me`)).json()).sources.map((entry) => entry.sourceId)).toEqual(['demo', 'other']);
      expect(await (await fetch(`${base}/v1/sources/other/profile`)).json()).toMatchObject({ sourceId: 'other' });
      expect(await (await fetch(`${base}/v1/entities/other/thing/T-1`)).json()).toMatchObject({ ref: { sourceId: 'other', stableId: 'T-1' } });
      expect(await (await fetch(`${base}/v1/entities/demo/thing/T-1`)).json()).toMatchObject({ ref: { sourceId: 'demo', stableId: 'T-1' } });
    });

    it('refuses the first source’s types under the second source and the second’s under the first', async () => {
      const base = await startTwo();
      expect((await openIn(base, 'demo', {}, 'extra')).status).toBe(400);
      expect((await openIn(base, 'other', {}, 'extra')).status).toBe(201);
      expect((await fetch(`${base}/v1/entities/demo/extra/T-1`)).status).toBe(404);
      expect((await fetch(`${base}/v1/entities/nowhere/thing/T-1`)).status).toBe(404);
    });

    it('reuses an investigation by case reference within one source only, so the same reference, type and ID make two', async () => {
      const base = await startTwo();
      const first = openInvestigationResponseSchema.parse(await (await openIn(base, 'demo', { caseRef: 'CASE-1' })).json());
      const other = await openIn(base, 'other', { caseRef: 'CASE-1' });
      expect(other.status).toBe(201);
      const created = openInvestigationResponseSchema.parse(await other.json());
      expect(created.investigation).toMatchObject({ sourceId: 'other' });
      expect(created.investigation.id).not.toBe(first.investigation.id);
      const again = await openIn(base, 'demo', { caseRef: 'CASE-1' });
      expect(again.status).toBe(200);
      expect(await again.json()).toMatchObject({ created: false, investigation: { id: first.investigation.id, sourceId: 'demo' } });
    });

    it('refuses a request whose reference names the other source, with SOURCE_MISMATCH, and an unknown source', async () => {
      const base = await startTwo();
      const mismatch = await open(base, { sourceId: 'demo', entity: { sourceId: 'other', entityType: 'thing', stableId: 'T-1' } });
      expect(mismatch.status).toBe(400);
      expect(await mismatch.json()).toMatchObject({ error: { code: 'SOURCE_MISMATCH' } });
      expect((await openIn(base, 'nowhere')).status).toBe(404);
    });

    it('answers a source it lists but refuses, a source it does not list and a missing entity with the same 404 body, for an open and for an entity read', async () => {
      const server = createSupportServer({ root: folder, profile: { sourceId: 'demo', entityTypes: [{ type: 'thing' }] }, otherProfiles: [{ sourceId: 'closed', entityTypes: [{ type: 'thing' }] }], refusedSources: ['closed'] });
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      closing = () => new Promise<void>((done) => void server.close(() => done()));
      const base = baseOf(server);
      expect(sourcesResponseSchema.parse(await (await fetch(`${base}/v1/sources`)).json()).items.map((item) => item.id)).toEqual(['demo', 'closed']);
      const answers = await Promise.all([openIn(base, 'closed'), openIn(base, 'nowhere'), openIn(base, 'demo', {}, 'thing').then(() => open(base, { sourceId: 'demo', entity: { sourceId: 'demo', entityType: 'thing', stableId: 'missing' } }))]);
      for (const reply of answers) expect(reply.status).toBe(404);
      expect(new Set(await Promise.all(answers.map((reply) => reply.text()))).size).toBe(1);
      const reads = await Promise.all([fetch(`${base}/v1/entities/closed/thing/T-1`), fetch(`${base}/v1/entities/nowhere/thing/T-1`), fetch(`${base}/v1/entities/demo/thing/missing`)]);
      expect(new Set(await Promise.all(reads.map((reply) => reply.text()))).size).toBe(1);
      expect(reads.map((reply) => reply.status)).toEqual([404, 404, 404]);
    });
  });

  it('answers 404 for an entity named missing and an unknown investigation, 400 for an unknown type, and 400 for a request that names another source', async () => {
    const base = await startWithTypes();
    expect((await open(base, request({ entity: { sourceId: 'demo', entityType: 'thing', stableId: 'missing' } }))).status).toBe(404);
    expect((await open(base, request({ entity: { sourceId: 'demo', entityType: 'other', stableId: 'T-1' } }))).status).toBe(400);
    expect((await open(base, request({ entity: { sourceId: 'elsewhere', entityType: 'thing', stableId: 'T-1' } }))).status).toBe(400);
    expect((await open(base, 'not an object')).status).toBe(400);
    expect((await fetch(`${base}/v1/investigations/0192f000-0000-7000-8000-0000000000ee`)).status).toBe(404);
    expect((await fetch(`${base}/v1/entities/demo/thing/missing`)).status).toBe(404);
    expect((await fetch(`${base}/v1/entities/demo/thing/~`)).status).toBe(400);
    expect(await (await fetch(`${base}/v1/entities/demo/thing/~..`)).json()).toMatchObject({ ref: { stableId: '..' } });
  });
});

describe('the page for an address that is not a file', () => {
  it('serves the page for an address with a dot in it or ending in dots, for every first segment that does not collide with the API (the routes of the web app and the folder and files of the build included), for a probe path with more after it, and answers the API for /v1 and under it', async () => {
    const base = await start();
    for (const path of ['/s/entity/account/~..', '/s/entity/account/AC.1', '/s/entity/account/1.2.3', '/s/entity/account/x..', '/v10/entity/a/b', '/v1-other/entity/a/b', '/healthz/entity/a/b', '/readyz/entity/a/b', '/assets2/entity/a/b', '/assets/entity/a/b', '/explore/entity/a/b', '/investigations/entity/a/b', '/sources/entity/a/b', '/dev/entity/a/b', '/index.html/entity/a/b']) {
      expect(await (await fetch(base + path)).text(), path).toBe('<!doctype html><title>app</title>');
    }
    for (const path of ['/v1/entity/a/b', '/v1']) expect((await fetch(base + path)).headers.get('content-type'), path).toContain('application/json');
    expect(await (await fetch(`${base}/assets/missing.js`)).text()).toBe('<!doctype html><title>app</title>');
  });
});

describe('the support server, searching', () => {
  const searchOf = async (base: string, body: unknown) =>
    fetch(`${base}/v1/search/entities`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('answers one match for a text, with an exact count, that the contract accepts', async () => {
    const base = await start();
    const reply = await searchOf(base, { sourceId: 'demo', text: 'AC-1' });
    expect(reply.status).toBe(200);
    const answer = searchResultSchema.parse(await reply.json());
    expect(answer.exact.map((hit) => hit.ref)).toEqual([{ sourceId: 'demo', entityType: 'account', stableId: 'AC-1' }]);
    expect(answer.counts.exact).toMatchObject({ value: 1, quality: 'exact' });
    expect(answer).toMatchObject({ cap: 25, searchable: true });
  });

  it.each([
    ['many-24', 24, 'exact'],
    ['many-25', 25, 'exact'],
    ['many-26', 25, 'lowerBound'],
    ['many-40', 25, 'lowerBound'],
    ['missing-1', 0, 'exact'],
  ])('answers %s with %i hits and an %s count', async (text, shown, quality) => {
    const base = await start();
    const answer = searchResultSchema.parse(await (await searchOf(base, { sourceId: 'demo', text })).json());
    expect(answer.exact).toHaveLength(shown);
    expect(answer.counts.exact).toMatchObject({ value: shown, quality });
  });

  it('times out the first search of a text that starts with stall, with the timeout of the source, and answers the next, for each such text on its own', async () => {
    const base = await start();
    const first = await searchOf(base, { sourceId: 'demo', text: 'stall-a' });
    expect(first.status).toBe(504);
    expect(await first.json()).toMatchObject({ error: { code: 'QUERY_TIMEOUT', details: { timeoutMs: 5000 } } });
    expect((await searchOf(base, { sourceId: 'demo', text: 'stall-a' })).status).toBe(200);
    expect((await searchOf(base, { sourceId: 'demo', text: 'stall-b' })).status).toBe(504);
  });

  it('refuses a body the contract does not accept, and a source it does not list', async () => {
    const base = await start();
    expect((await searchOf(base, { sourceId: 'demo', text: '' })).status).toBe(400);
    expect((await searchOf(base, { sourceId: 'demo', text: 'a'.repeat(201) })).status).toBe(400);
    expect((await searchOf(base, { sourceId: 'demo', text: 'a' })).status).toBe(200);
    expect((await searchOf(base, { sourceId: 'demo', text: 'ab', extra: 1 })).status).toBe(400);
    expect((await searchOf(base, { sourceId: 'other', text: 'ab' })).status).toBe(404);
  });
});

describe('the support server\'s source health', () => {
  const post = (base: string, path: string, body: unknown = {}): Promise<Response> => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const sourcesOf = async (base: string) => sourcesResponseSchema.parse(await (await fetch(`${base}/v1/sources`)).json()).items;

  async function startTwo(): Promise<string> {
    const server = createSupportServer({ root: folder, profile: { sourceId: 'demo' }, otherProfiles: [{ sourceId: 'other' }] });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    closing = () => new Promise<void>((done) => void server.close(() => done()));
    return baseOf(server);
  }

  it('lists every source connected and never tested until a spec changes one, and changes only the fields it names', async () => {
    const base = await startTwo();
    expect((await sourcesOf(base)).map((item) => [item.id, item.state, item.lastTest])).toEqual([['demo', 'connected', null], ['other', 'connected', null]]);
    expect((await post(base, '/__support/sources', { other: { state: 'unavailable', stateReason: 'Connection refused' } })).status).toBe(200);
    const [demo, other] = await sourcesOf(base);
    expect([demo?.state, demo?.stateReason, other?.state, other?.stateReason, other?.mappingSummary]).toEqual(['connected', null, 'unavailable', 'Connection refused', { entityTypes: 4, relationshipTypes: 6, derivedRules: 2 }]);
  });

  it('refuses a change for an unknown source or an invalid field, and changes nothing', async () => {
    const base = await startTwo();
    expect((await post(base, '/__support/sources', { nowhere: { state: 'degraded' } })).status).toBe(400);
    expect((await post(base, '/__support/sources', { demo: { state: 'sleeping' } })).status).toBe(400);
    expect((await post(base, '/__support/sources', { demo: { surprise: true } })).status).toBe(400);
    expect((await post(base, '/__support/sources', { demo: { synthetic: false, demoCase: { entityType: 'thing', stableId: 'T-1', caseRef: 'R' } } })).status).toBe(400);
    expect((await post(base, '/__support/nothing')).status).toBe(404);
    expect((await sourcesOf(base)).map((item) => item.state)).toEqual(['connected', 'connected']);
  });

  it('answers a test with a report that parses as the contract\'s and stores it as the source\'s last test', async () => {
    const base = await startTwo();
    const reply = await post(base, '/v1/sources/other/test');
    expect(reply.status).toBe(200);
    const report = sourceTestReportSchema.parse(await reply.json());
    expect(report.sourceId).toBe('other');
    const [demo, other] = await sourcesOf(base);
    expect(demo?.lastTest).toBeNull();
    expect(other?.lastTestAt).toBe(report.checkedAt);
    expect(other?.lastTest).toMatchObject({ checkedAt: report.checkedAt, readOnlyCheck: 'privileges-inspected', outcome: 'pass' });
    expect((await post(base, '/v1/sources/nowhere/test')).status).toBe(404);
  });

  it('holds back the sources read that follows a test until it is released, and not before a test', async () => {
    const base = await startTwo();
    await post(base, '/__support/hold-after-test');
    expect((await sourcesOf(base)).length).toBe(2);
    await post(base, '/v1/sources/demo/test');
    let answered = false;
    const pending = sourcesOf(base).then((items) => {
      answered = true;
      return items;
    });
    await new Promise<void>((done) => setTimeout(done, 100));
    expect(answered).toBe(false);
    await post(base, '/__support/release');
    expect((await pending)[0]?.lastTest).not.toBeNull();
    expect(answered).toBe(true);
  });

  it('puts every source back, releases a held read and clears the hold on reset', async () => {
    const base = await startTwo();
    await post(base, '/__support/sources', { demo: { state: 'degraded', stateReason: 'Degree counts are estimated' } });
    await post(base, '/__support/hold-after-test');
    await post(base, '/v1/sources/other/test');
    const pending = sourcesOf(base);
    await post(base, '/__support/reset');
    expect((await pending).length).toBe(2);
    const after = await sourcesOf(base);
    expect(after.map((item) => [item.state, item.lastTest])).toEqual([['connected', null], ['connected', null]]);
    await post(base, '/v1/sources/demo/test');
    expect((await sourcesOf(base)).length).toBe(2);
  });
});

describe('the support server\'s named views', () => {
  const post = (base: string, path: string, body: unknown = {}): Promise<Response> => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  async function startWithTypes(): Promise<string> {
    const server = createSupportServer({ root: folder, profile: { sourceId: 'demo', entityTypes: [{ type: 'thing' }] } });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    closing = () => new Promise<void>((done) => void server.close(() => done()));
    return baseOf(server);
  }
  const counted = async (base: string) => investigationListResponseSchema.parse(await (await fetch(`${base}/v1/investigations`)).json()).counts.savedViews;

  it('counts no named view until a spec holds some, then answers the count and the time, and forgets them on reset', async () => {
    const base = await startWithTypes();
    expect(await counted(base)).toEqual({ count: { value: 0, quality: 'exact', scope: 'named-views' }, lastEditedAt: null });
    expect((await post(base, '/__support/named-views', { count: 2, lastEditedAt: '2026-11-05T09:42:00.000Z' })).status).toBe(200);
    expect(await counted(base)).toEqual({ count: { value: 2, quality: 'exact', scope: 'named-views' }, lastEditedAt: '2026-11-05T09:42:00.000Z' });
    await post(base, '/__support/reset');
    expect((await counted(base)).count.value).toBe(0);
  });

  it('accepts a time the contract accepts, including one without milliseconds', async () => {
    const base = await startWithTypes();
    expect((await post(base, '/__support/named-views', { count: 1, lastEditedAt: '2026-11-05T09:42:00Z' })).status).toBe(200);
    expect((await counted(base)).lastEditedAt).toBe('2026-11-05T09:42:00Z');
  });

  it('refuses a count that is not a whole number, a time that is not a time, and a count and a time that disagree, and changes nothing', async () => {
    const base = await startWithTypes();
    for (const body of [{ count: -1, lastEditedAt: null }, { count: 1.5, lastEditedAt: null }, { count: 2 ** 60, lastEditedAt: '2026-11-05T09:42:00.000Z' }, { count: 1, lastEditedAt: 'yesterday' }, { count: 1, lastEditedAt: '+010000-01-01T00:00:00.000Z' }, { count: 1, lastEditedAt: null }, { count: 0, lastEditedAt: '2026-11-05T09:42:00.000Z' }, { count: 1, lastEditedAt: '2026-11-05T09:42:00.000Z', extra: true }, { count: 'x' }, null, []]) {
      expect((await post(base, '/__support/named-views', body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await counted(base)).count.value).toBe(0);
  });
});
