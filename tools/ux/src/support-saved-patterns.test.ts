import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorResponseSchema, patternListResponseSchema, savedPatternRunResponseSchema, savedPatternSchema, templateRunResponseSchema } from '@neburyx/contracts';
import { IncomingMessage, ServerResponse } from 'node:http';
import { createSavedPatterns } from './support-saved-patterns.ts';
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

  it('refuses a name the person already has as a CONFLICT with the reason pattern-name-taken, for a save, a rename and a change, and numbers the copies', async () => {
    const taken = await call('POST', '/v1/patterns', { sourceId: 'banking-demo', kind: 'definition', name: 'Device ring', definition: DEFINITION });
    expect(taken.status).toBe(409);
    expect(errorResponseSchema.parse(await taken.json()).error).toMatchObject({ code: 'CONFLICT', details: { reason: 'pattern-name-taken' } });
    expect((await call('PUT', `/v1/patterns/${OWN}`, { expectedVersion: 1, name: 'Retired pattern' })).status).toBe(409);
    expect((await call('PUT', `/v1/patterns/${OWN}`, { expectedVersion: 1, name: 'Device ring' })).status).toBe(200);
    const first = savedPatternSchema.parse(await (await call('POST', `/v1/patterns/${OWN}/copy`)).json());
    const second = savedPatternSchema.parse(await (await call('POST', `/v1/patterns/${OWN}/copy`)).json());
    expect([first.name, second.name]).toEqual(['Device ring (copy)', 'Device ring (copy 2)']);
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

  it('saves a run of a built-in pattern with its parameters, lists it as one, and runs it through the preset run with the entity asked or the one held', async () => {
    const saved = savedPatternSchema.parse(await (await call('POST', '/v1/patterns', { sourceId: 'banking-demo', kind: 'preset-run', name: 'Week', presetId: 'shared-devices', params: { limit: 25 } })).json());
    expect(saved).toMatchObject({ kind: 'preset-run', presetId: 'shared-devices', templateId: 'shared-attribute', templateVersion: 1, params: { limit: 25 } });
    expect((await listed())[0]).toMatchObject({ name: 'Week', kind: 'preset-run', params: { limit: 25 }, askForStartingEntity: true });
    expect((await call('POST', `/v1/patterns/${saved.id}/run`, {}, { 'idempotency-key': 'a-key-of-sixteen-characters' })).status).toBe(400);
    const ran = savedPatternRunResponseSchema.parse(await (await call('POST', `/v1/patterns/${saved.id}/run`, { anchor: { entityType: 'account', stableId: 'AC-1' } }, { 'idempotency-key': 'a-key-of-sixteen-characters' })).json());
    expect(templateRunResponseSchema.parse(ran)).toMatchObject({ status: 'ok', presetId: 'shared-devices' });
  });

  it('gives a saved run of a linked-entities preset that template, and a shared-attribute preset the other', async () => {
    const claims = createSupportServer({ root: folder, profile: { sourceId: 'banking-demo', presets: [{ id: 'claimant-claims', template: 'linked-entities' }, { id: 'shared-addresses', template: 'shared-attribute' }] } });
    await new Promise<void>((done) => claims.listen(0, '127.0.0.1', done));
    const address = claims.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const post = (body: unknown) => fetch(`http://127.0.0.1:${address.port}/v1/patterns`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const linked = savedPatternSchema.parse(await (await post({ sourceId: 'banking-demo', kind: 'preset-run', name: 'Linked', presetId: 'claimant-claims', params: {} })).json());
    const shared = savedPatternSchema.parse(await (await post({ sourceId: 'banking-demo', kind: 'preset-run', name: 'Shared', presetId: 'shared-addresses', params: {} })).json());
    expect([linked.kind === 'preset-run' ? linked.templateId : '', shared.kind === 'preset-run' ? shared.templateId : '']).toEqual(['linked-entities', 'shared-attribute']);
    await new Promise<void>((done) => void claims.close(() => done()));
  });

  it('hands the preset run the entity, the stored parameters with the limit of the run, the mask and the continuation', async () => {
    const seen: unknown[] = [];
    const response = (): ServerResponse => new ServerResponse(new IncomingMessage(new Socket()));
    const saved = createSavedPatterns(
      async () => undefined,
      async (presetId, body) => void seen.push({ presetId, body }),
      () => 'shared-attribute',
    );
    let id = '';
    const reply = response();
    vi.spyOn(reply, 'end').mockImplementation((chunk?: unknown) => {
      id = savedPatternSchema.parse(JSON.parse(String(chunk))).id;
      return reply;
    });
    saved.save({ sourceId: 'banking-demo', kind: 'preset-run', name: 'Spied', presetId: 'shared-devices', params: { limit: 25, minShared: 2 } }, reply);
    await saved.run(id, { anchor: { entityType: 'account', stableId: 'AC-1' }, limit: 5, mask: true, continue: true }, response(), new IncomingMessage(new Socket()));
    expect(seen).toEqual([{ presetId: 'shared-devices', body: { sourceId: 'banking-demo', params: { ref: { entityType: 'account', stableId: 'AC-1' }, limit: 5, minShared: 2 }, mask: true, continue: true } }]);
  });
});
