import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { meResponseSchema, sourceProfileSchema, sourcesResponseSchema } from '@neburyx/contracts';
import { createSupportServer } from './support-server.ts';

const committed: unknown = JSON.parse(readFileSync(new URL('../fixtures/profile.json', import.meta.url), 'utf8'));

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
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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
    expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404);
  });

  it('does not serve a file outside the folder', async () => {
    const base = await start();
    const reply = await fetch(`${base}/..%2f..%2fetc%2fhosts`);
    expect(reply.status).not.toBe(200);
  });

  it('answers bodies the web app accepts: the contracts parse them, and the profile is the committed one', async () => {
    const profile = sourceProfileSchema.parse(committed);
    const server = createSupportServer({ root: folder, profile });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    closing = () => new Promise<void>((done) => void server.close(() => done()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect(meResponseSchema.safeParse(await (await fetch(`${base}/v1/me`)).json()).success).toBe(true);
    const sources = sourcesResponseSchema.parse(await (await fetch(`${base}/v1/sources`)).json());
    expect(sources.items.map((item) => item.id)).toEqual([profile.sourceId]);
    expect(sourceProfileSchema.parse(await (await fetch(`${base}/v1/sources/${profile.sourceId}/profile`)).json())).toEqual(profile);
  });
});
