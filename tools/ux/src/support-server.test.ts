import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { investigationResponseSchema, meResponseSchema, openInvestigationResponseSchema, sourceProfileSchema, sourcesResponseSchema } from '@neburyx/contracts';
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
