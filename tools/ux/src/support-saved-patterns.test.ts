import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { patternListResponseSchema, savedPatternRunResponseSchema, savedPatternSchema } from '@neburyx/contracts';
import { createSupportServer } from './support-server.ts';

let folder = '';
let server: Server | undefined;
let base = '';

beforeEach(async () => {
  folder = mkdtempSync(join(tmpdir(), 'ux-saved-'));
  writeFileSync(join(folder, 'index.html'), '<!doctype html><title>app</title>');
  server = createSupportServer({ root: folder, profile: { sourceId: 'demo' } });
  await new Promise<void>((done) => server?.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((done) => void server?.close(() => done()));
  rmSync(folder, { recursive: true, force: true });
});

const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const listed = async () => patternListResponseSchema.parse(await (await call('GET', '/v1/patterns?sourceId=banking-demo')).json()).items;
const OWN = '0192f000-0000-7000-8000-000000000001';
const OTHERS = '0192f000-0000-7000-8000-000000000002';
const RETIRED = '0192f000-0000-7000-8000-000000000003';
const DEFINITION = { anchorType: 'account', steps: [{ relationshipTypes: ['USES_DEVICE'], direction: 'out', arrivesAt: 'device' }] };

describe('the saved patterns of the support server', () => {
  it('lists the three seeded patterns of the source with who made each, and none of another source', async () => {
    const items = await listed();
    expect(items.map((item) => [item.name, item.ownedByYou, item.visibility, item.availability.status])).toEqual([
      ['Device ring', true, 'private', 'available'],
      ['Shared by Pat', false, 'shared', 'available'],
      ['Retired pattern', true, 'private', 'unavailable'],
    ]);
    expect(patternListResponseSchema.parse(await (await call('GET', '/v1/patterns?sourceId=other')).json()).items).toEqual([]);
  });

  it('saves, changes with the version, shares, copies and deletes in memory, refusing a stale version, another person’s pattern and an unknown one', async () => {
    const saved = savedPatternSchema.parse(await (await call('POST', '/v1/patterns', { sourceId: 'banking-demo', kind: 'definition', name: ' Mine ', definition: DEFINITION })).json());
    expect(saved.name).toBe('Mine');
    expect((await listed())[0]?.id).toBe(saved.id);
    expect((await call('PUT', `/v1/patterns/${saved.id}`, { expectedVersion: 5, name: 'X' })).status).toBe(409);
    const shared = savedPatternSchema.parse(await (await call('PUT', `/v1/patterns/${saved.id}`, { expectedVersion: 1, visibility: 'shared' })).json());
    expect([shared.visibility, shared.version]).toEqual(['shared', 2]);
    expect((await call('PUT', `/v1/patterns/${OTHERS}`, { expectedVersion: 1, name: 'X' })).status).toBe(403);
    expect((await call('DELETE', `/v1/patterns/${OTHERS}`, undefined, { 'if-match': '"1"' })).status).toBe(403);
    const copy = savedPatternSchema.parse(await (await call('POST', `/v1/patterns/${OTHERS}/copy`)).json());
    expect([copy.name, copy.visibility]).toEqual(['Shared by Pat (copy)', 'private']);
    expect((await call('DELETE', `/v1/patterns/${saved.id}`, undefined, { 'if-match': '"1"' })).status).toBe(409);
    expect((await call('DELETE', `/v1/patterns/${saved.id}`, undefined, { 'if-match': '"2"' })).status).toBe(200);
    expect((await call('DELETE', `/v1/patterns/${saved.id}`, undefined, { 'if-match': '"2"' })).status).toBe(404);
    expect((await call('PUT', `/v1/patterns/not-there`, { expectedVersion: 1, name: 'X' })).status).toBe(404);
  });

  it('runs a saved pattern with its held starting entity, needs one for a pattern that holds none, and answers unavailable for the retired one', async () => {
    const ran = savedPatternRunResponseSchema.parse(await (await call('POST', `/v1/patterns/${OWN}/run`, {}, { 'idempotency-key': 'a-key-of-sixteen-characters' })).json());
    expect(ran.status).toBe('ok');
    expect((await call('POST', `/v1/patterns/${OTHERS}/run`, {}, { 'idempotency-key': 'a-key-of-sixteen-characters' })).status).toBe(400);
    const given = savedPatternRunResponseSchema.parse(await (await call('POST', `/v1/patterns/${OTHERS}/run`, { anchor: { entityType: 'account', stableId: 'AC-1' } }, { 'idempotency-key': 'a-key-of-sixteen-characters' })).json());
    expect(given.status).toBe('ok');
    expect(savedPatternRunResponseSchema.parse(await (await call('POST', `/v1/patterns/${RETIRED}/run`, { anchor: { entityType: 'account', stableId: 'AC-1' } }, { 'idempotency-key': 'a-key-of-sixteen-characters' })).json())).toMatchObject({ status: 'unavailable' });
  });

  it('puts the three seeded patterns back on reset', async () => {
    await call('DELETE', `/v1/patterns/${OWN}`, undefined, { 'if-match': '"1"' });
    expect(await listed()).toHaveLength(2);
    await call('POST', '/__support/reset', {});
    expect(await listed()).toHaveLength(3);
  });
});
