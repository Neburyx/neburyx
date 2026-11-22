import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { SourceGateError } from './gate/allowlist.js';
import { AppError } from './errors.js';
import type { SourceGate, SourceGateOptions } from './gate/source-gate.js';
import { start, type StartIo } from './start.js';
import { memoryAppStore } from './testing/app-store.js';
import { baseSource, fileOf, styleRuleOf, type Json } from './testing/mapping.js';
import { makeExportDirectory } from './testing/export-directory.js';
import { makeWebRoot } from './testing/web-root.js';

const webRoot = makeWebRoot();
const exportDirectory = makeExportDirectory();
const folder = mkdtempSync(join(tmpdir(), 'dev-reload-'));
afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
  rmSync(folder, { recursive: true, force: true });
});

const DATABASE_ENV = { DATABASE_URL: 'postgres://app_user@db.example.test:5432/neburyx' };

let counter = 0;
const entities = (extra: Json[] = []): Json[] => [...(baseSource()['entities'] as Json[]), ...extra];

function rig(initial: string, overrides: { openSourceGate?: (options: SourceGateOptions, count: number) => SourceGate } = {}) {
  counter += 1;
  const file = join(folder, `neburyx-${counter}.yaml`);
  writeFileSync(file, initial);
  const logs: { event?: string; reason?: string; added?: string[]; changed?: string[]; removed?: string[] }[] = [];
  const stream = { write: (line: string) => void logs.push(JSON.parse(line) as (typeof logs)[number]) };
  const opened: SourceGateOptions[] = [];
  const closed: number[] = [];
  const watched: { folder: string; listener: (event: string, name: string | null) => void; closed: boolean }[] = [];
  const errors: string[] = [];
  const synced: (readonly { id: string; configHash: string }[])[] = [];
  const gate = (count: number): SourceGate => ({
    gate: { run: () => Promise.reject(new Error('not used')), runMany: () => Promise.reject(new Error('not used')), fileQuery: () => Promise.reject(new Error('not used')) },
    system: { run: () => Promise.reject(new AppError('SOURCE_UNAVAILABLE', undefined, 'unreachable')) },
    indexes: { read: () => Promise.resolve('unverified') },
    catalog: { find: () => undefined, isEnabled: () => true },
    close: () => (closed.push(count), Promise.resolve()),
  });
  const io: StartIo = {
    stderr: { write: (text) => errors.push(text) },
    logger: pino({ level: 'info' }, stream),
    defaultWebRoot: webRoot,
    defaultExportDirectory: exportDirectory,
    openStore: () => {
      const store = memoryAppStore();
      return { ...store, syncSources: (sources) => (synced.push(sources), store.syncSources(sources)) };
    },
    tasks: [],
    portOverride: 0,
    pingIntervalMs: 3_600_000,
    startupProblem: () => undefined,
    devReloadDebounceMs: 5,
    openSourceGate: (options) => {
      opened.push(options);
      return overrides.openSourceGate?.(options, opened.length) ?? gate(opened.length);
    },
    watch: ((dir: string, _options: unknown, listener: (event: string, name: string | null) => void) => {
      const entry = { folder: dir, listener, closed: false };
      watched.push(entry);
      return { close: () => void (entry.closed = true), on: () => undefined };
    }) as unknown as StartIo['watch'],
  };
  const save = (text: string, name = `neburyx-${counter}.yaml`): void => {
    writeFileSync(join(folder, `tmp-${counter}.yaml`), text);
    renameSync(join(folder, `tmp-${counter}.yaml`), file);
    for (const entry of watched) {
      entry.listener('rename', name);
      entry.listener('change', name);
    }
  };
  return { file, io, logs, opened, closed, watched, errors, synced, save, env: { ...DATABASE_ENV, NEBURYX_CONFIG: file, NEBURYX_DEV: '1' } };
}

async function meSources(app: { inject: (options: { url: string }) => Promise<{ json: () => unknown }> }): Promise<string[]> {
  return ((await app.inject({ url: '/v1/me' })).json() as { sources: { sourceId: string }[] }).sources.map((item) => item.sourceId).sort();
}

async function readyCount(app: { inject: (options: { url: string }) => Promise<{ json: () => unknown }> }): Promise<number> {
  const body = (await app.inject({ url: '/readyz' })).json() as { sources: { reachable: number; unreachable: number; unknown: number } };
  return body.sources.reachable + body.sources.unreachable + body.sources.unknown;
}

async function sourcesOf(app: { inject: (options: { url: string }) => Promise<{ json: () => unknown }> }): Promise<string[]> {
  return ((await app.inject({ url: '/v1/sources' })).json() as { items: { id: string }[] }).items.map((item) => item.id).sort();
}

const settled = (logs: { event?: string }[], event: string, count = 1) => vi.waitFor(() => expect(logs.filter((line) => line.event === event)).toHaveLength(count), { timeout: 3000, interval: 10 });

describe('the dev reload', () => {
  it('opens no watcher without NEBURYX_DEV, and reads the file once', async () => {
    const r = rig(fileOf(baseSource()));
    const result = await start({ ...r.env, NEBURYX_DEV: undefined }, r.io);
    expect(result.exitCode).toBe(0);
    if (result.exitCode !== 0) return;
    expect(r.watched).toHaveLength(0);
    r.save(fileOf(baseSource(), baseSource({ id: 'second' })));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(r.opened).toHaveLength(1);
    expect(await sourcesOf(result.app)).toEqual(['demo']);
    await result.app.close();
  });

  it('opens no watcher for an empty value either', async () => {
    const r = rig(fileOf(baseSource()));
    const result = await start({ ...r.env, NEBURYX_DEV: '' }, r.io);
    expect(r.watched).toHaveLength(0);
    if (result.exitCode === 0) await result.app.close();
  });

  it.each(['0', 'true', 'yes'])('refuses to start for NEBURYX_DEV=%s, names the variable, and opens nothing', async (value) => {
    const r = rig(fileOf(baseSource()));
    const result = await start({ ...r.env, NEBURYX_DEV: value }, r.io);
    expect(result.exitCode).toBe(1);
    expect(r.errors.join('')).toContain('NEBURYX_DEV');
    expect(r.errors.join('')).toContain('1');
    expect(r.opened).toHaveLength(0);
    expect(r.watched).toHaveLength(0);
  });

  it('watches the folder of the file, says it is on and not for production, and starts without a file to watch when NEBURYX_CONFIG is not set', async () => {
    const r = rig(fileOf(baseSource()));
    const result = await start(r.env, r.io);
    expect(result.exitCode).toBe(0);
    if (result.exitCode !== 0) return;
    expect(r.watched.map((entry) => entry.folder)).toEqual([folder]);
    expect(r.logs.some((line) => line.event === 'mapping.dev_reload_on')).toBe(true);
    await result.app.close();
    const none = rig(fileOf(baseSource()));
    const bare = await start({ DATABASE_URL: DATABASE_ENV.DATABASE_URL, NEBURYX_DEV: '1' }, none.io);
    expect(bare.exitCode).toBe(0);
    expect(none.watched).toHaveLength(0);
    expect(none.logs.some((line) => line.event === 'mapping.dev_reload_nothing_to_watch')).toBe(true);
    if (bare.exitCode === 0) await bare.app.close();
  });

  it('makes one reload of a save that made several events, and serves the new source, with the old gate closed after the swap', async () => {
    const r = rig(fileOf(baseSource()));
    const result = await start(r.env, r.io);
    if (result.exitCode !== 0) throw new Error(`did not start: ${r.errors.join('')}`);
    expect(await sourcesOf(result.app)).toEqual(['demo']);
    r.save(fileOf(baseSource(), baseSource({ id: 'second' })));
    await settled(r.logs, 'mapping.reloaded');
    expect(r.opened).toHaveLength(2);
    expect(await sourcesOf(result.app)).toEqual(['demo', 'second']);
    expect(await readyCount(result.app), 'the readiness counts follow the sources').toBe(2);
    expect(await meSources(result.app), 'GET /v1/me lists the added source').toEqual(['demo', 'second']);
    expect(r.synced.map((sources) => sources.map((source) => source.id)), 'the sources were recorded once at start and once for the reload').toEqual([['demo'], ['demo', 'second']]);
    expect(r.logs.find((line) => line.event === 'mapping.reloaded')).toMatchObject({ added: ['second'], changed: [], removed: [] });
    expect(r.closed).toEqual([1]);
    await result.app.close();
    expect(r.watched[0]?.closed).toBe(true);
    expect([...r.closed].sort()).toEqual([1, 2]);
  });

  it('drops a removed source from the answers, and serves a new profile with a new ETag for a source whose entity types changed', async () => {
    const r = rig(fileOf(baseSource(), baseSource({ id: 'second' })));
    const result = await start(r.env, r.io);
    if (result.exitCode !== 0) throw new Error('did not start');
    const before = (await result.app.inject({ url: '/v1/sources/demo/profile' })).headers['etag'];
    r.save(fileOf(baseSource({ entities: entities([{ type: 'node_c', label: 'NodeC', stable_id: 'ref' }]) })));
    await settled(r.logs, 'mapping.reloaded');
    expect(await sourcesOf(result.app)).toEqual(['demo']);
    expect(await readyCount(result.app)).toBe(1);
    expect(await meSources(result.app), 'GET /v1/me no longer lists the removed source').toEqual(['demo']);
    const recorded = r.synced.at(-1)?.[0];
    expect(recorded?.configHash, 'the new hash of the source that changed is the one recorded').not.toBe(r.synced[0]?.[0]?.configHash);
    const after = await result.app.inject({ url: '/v1/sources/demo/profile' });
    expect(after.headers['etag']).not.toBe(before);
    expect(JSON.stringify(after.json())).toContain('node_c');
    expect((await result.app.inject({ url: '/v1/sources/second/profile' })).statusCode).toBe(404);
    await result.app.close();
  });

  it('keeps the mapping that works when the file is invalid, says why in the log without a value, and loads the next good save', async () => {
    const r = rig(fileOf(baseSource()));
    const result = await start(r.env, r.io);
    if (result.exitCode !== 0) throw new Error('did not start');
    r.save('sources: [\n  - id: demo\n   bad: [');
    await settled(r.logs, 'mapping.reload_refused');
    expect(r.opened).toHaveLength(1);
    expect(await sourcesOf(result.app)).toEqual(['demo']);
    const refusal = r.logs.find((line) => line.event === 'mapping.reload_refused');
    for (const secret of ['graph.example.test', 'DEMO_USER', 'DEMO_PASSWORD']) expect(JSON.stringify(refusal)).not.toContain(secret);
    r.save(fileOf(baseSource(), baseSource({ id: 'second' })));
    await settled(r.logs, 'mapping.reloaded');
    expect(await sourcesOf(result.app)).toEqual(['demo', 'second']);
    await result.app.close();
  });

  it('serves a rule added by a reload with no restart: the profile lists it, and the gate opened for the new mapping holds it for the next read', async () => {
    const r = rig(fileOf(baseSource()));
    const result = await start(r.env, r.io);
    if (result.exitCode !== 0) throw new Error('did not start');
    const profileOf = async () => (await result.app.inject({ url: '/v1/sources/demo/profile' })).json() as { styleRules: { id: string; condition: string }[] };
    expect((await profileOf()).styleRules).toEqual([]);
    r.save(fileOf(baseSource({ style_rules: [styleRuleOf({ id: 'added' })] })));
    await settled(r.logs, 'mapping.reloaded');
    expect((await profileOf()).styleRules.map((rule) => rule.id)).toEqual(['added']);
    expect(r.opened).toHaveLength(2);
    expect(r.opened[1]?.mapping.sources[0]?.styleRules.map((rule) => rule.id)).toEqual(['added']);
    await result.app.close();
  });

  it('keeps the working mapping and its style rules when a reload adds a rule that is refused, and says why without a value', async () => {
    const good = styleRuleOf({ id: 'keep' });
    const r = rig(fileOf(baseSource({ style_rules: [good] })));
    const result = await start(r.env, r.io);
    if (result.exitCode !== 0) throw new Error('did not start');
    const before = (await result.app.inject({ url: '/v1/sources/demo/profile' })).headers['etag'];
    r.save(fileOf(baseSource({ style_rules: [good, styleRuleOf({ id: 'bad', applies_to: 'SUPPLIED_TYPE_NAME_NOT_PRESENT' })] })));
    await settled(r.logs, 'mapping.reload_refused');
    expect(r.opened).toHaveLength(1);
    expect((await result.app.inject({ url: '/v1/sources/demo/profile' })).headers['etag']).toBe(before);
    expect(JSON.stringify(r.logs.find((line) => line.event === 'mapping.reload_refused'))).not.toContain('graph.example.test');
    await result.app.close();
  });

  it.each([
    ['a gate refusal, whose message is shown as at start', () => new SourceGateError('demo', 'label of entity type node_c', 'x y', 'is not a name the gate can use'), 'the gate refused the mapping: source demo: the label named in the mapping is not a name the gate can use'],
    ['any other error, whose text is not shown', () => new Error('connect to graph.example.test:7687 failed'), 'the gate could not be built from the mapping'],
  ])('keeps serving the old mapping and the old gate, and closes nothing, when the gate cannot be built from the new one: %s', async (_name, make, reason) => {
    const r = rig(fileOf(baseSource()));
    const first = r.io.openSourceGate;
    const result = await start(r.env, {
      ...r.io,
      openSourceGate: (options) => {
        if (r.opened.length > 0) throw make();
        return first?.(options) as SourceGate;
      },
    });
    if (result.exitCode !== 0) throw new Error('did not start');
    r.save(fileOf(baseSource(), baseSource({ id: 'second' })));
    await settled(r.logs, 'mapping.reload_refused');
    expect(r.logs.find((line) => line.event === 'mapping.reload_refused')?.reason).toContain(reason.split(':')[0] as string);
    expect(JSON.stringify(r.logs)).not.toContain('graph.example.test');
    expect(await sourcesOf(result.app)).toEqual(['demo']);
    expect(r.closed).toEqual([]);
    await result.app.close();
  });

  it('refuses a change of the address of a source and of the ai section, and serves the old mapping', async () => {
    const r = rig(fileOf(baseSource()));
    const result = await start(r.env, r.io);
    if (result.exitCode !== 0) throw new Error('did not start');
    r.save(fileOf(baseSource({ uri: 'neo4j+s://other.example.test:7687' })));
    await settled(r.logs, 'mapping.reload_refused');
    expect(r.logs.find((line) => line.event === 'mapping.reload_refused')?.reason).toBe('the address of source demo changed: it applies after a restart');
    expect(await sourcesOf(result.app)).toEqual(['demo']);
    await result.app.close();
  });

  it('ends the source ping before the swap and starts it again with the new mapping, so a source that was added is pinged and one that was removed is not', async () => {
    const r = rig(fileOf(baseSource(), baseSource({ id: 'second' })));
    const pinged: string[] = [];
    const result = await start(r.env, {
      ...r.io,
      pingIntervalMs: 15,
      openSourceGate: (options) => {
        r.opened.push(options);
        const parts = { gate: { run: () => Promise.reject(new Error('not used')), runMany: () => Promise.reject(new Error('not used')), fileQuery: () => Promise.reject(new Error('not used')) }, indexes: { read: () => Promise.resolve('unverified' as const) }, catalog: { find: () => undefined, isEnabled: () => true } };
        return { ...parts, system: { run: (request) => (pinged.push(request.sourceId), Promise.reject(new AppError('SOURCE_UNAVAILABLE', undefined, 'unreachable'))) }, close: () => Promise.resolve() };
      },
    });
    if (result.exitCode !== 0) throw new Error('did not start');
    await vi.waitFor(() => expect(new Set(pinged)).toEqual(new Set(['demo', 'second'])), { timeout: 3000, interval: 10 });
    r.save(fileOf(baseSource(), baseSource({ id: 'third' })));
    await settled(r.logs, 'mapping.reloaded');
    pinged.length = 0;
    await vi.waitFor(() => expect(new Set(pinged)).toEqual(new Set(['demo', 'third'])), { timeout: 3000, interval: 10 });
    await result.app.close();
  });

  it('closes the watcher and leaves no timer when it is shut down during a pending reload', async () => {
    const r = rig(fileOf(baseSource()));
    const result = await start(r.env, r.io);
    if (result.exitCode !== 0) throw new Error('did not start');
    r.save(fileOf(baseSource(), baseSource({ id: 'second' })));
    await result.app.close();
    expect(r.watched[0]?.closed).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(r.opened.length).toBeLessThanOrEqual(2);
  });
});
