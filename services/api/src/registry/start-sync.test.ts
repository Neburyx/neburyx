import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { AppStore } from '../app-store.js';
import { start, type StartIo } from '../start.js';
import { memoryStoreWith } from '../testing/app-store.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { makeWebRoot } from '../testing/web-root.js';

const webRoot = makeWebRoot();
const folder = mkdtempSync(join(tmpdir(), 'start-sync-'));
afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
  rmSync(folder, { recursive: true, force: true });
});

const ENV = { DATABASE_URL: 'postgres://app_user@db.example.test:5432/neburyx' };

function io(store: AppStore): { readonly io: StartIo; readonly errors: string[]; readonly logs: Record<string, unknown>[] } {
  const errors: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const logger = pino({ level: 'info' }, { write: (line: string) => logs.push(JSON.parse(line)) });
  return { errors, logs, io: { stderr: { write: (text) => errors.push(text) }, logger, defaultWebRoot: webRoot, openStore: () => store, tasks: [], portOverride: 0 } };
}

function mappingFile(...ids: string[]): string {
  const file = join(folder, `mapping-${ids.join('-')}.yaml`);
  writeFileSync(file, fileOf(...ids.map((id) => baseSource({ id }))));
  return file;
}

describe('the start-up sync', () => {
  it('hands the mapping sources to the store before it listens', async () => {
    const store = memoryStoreWith({});
    const sync = vi.spyOn(store, 'syncSources');
    const run = io(store);
    const result = await start({ ...ENV, NEBURYX_CONFIG: mappingFile('alpha', 'beta') }, run.io);
    expect(result.exitCode).toBe(0);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync.mock.calls[0]?.[0].map((source) => source.id)).toEqual(['alpha', 'beta']);
    if (result.exitCode === 0) await result.app.close();
  });

  it('hands an empty list to the store when no mapping file is set', async () => {
    const store = memoryStoreWith({});
    const sync = vi.spyOn(store, 'syncSources');
    const result = await start({ ...ENV }, io(store).io);
    expect(sync).toHaveBeenCalledWith([]);
    if (result.exitCode === 0) await result.app.close();
  });

  it('logs one event with only the source id for each source whose connection changed', async () => {
    const store = memoryStoreWith({});
    vi.spyOn(store, 'syncSources').mockResolvedValue(['alpha']);
    const run = io(store);
    const result = await start({ ...ENV, NEBURYX_CONFIG: mappingFile('alpha') }, run.io);
    const events = run.logs.filter((line) => line['event'] === 'source.identity_changed');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ sourceId: 'alpha' });
    expect(JSON.stringify(events)).not.toContain('graph.example.test');
    expect(JSON.stringify(events)).not.toContain('neo4j');
    if (result.exitCode === 0) await result.app.close();
  });

  it('exits 1 with no connection detail and opens no listener when the sync fails', async () => {
    const run = io(memoryStoreWith({ failSources: true }));
    const result = await start({ ...ENV, NEBURYX_CONFIG: mappingFile('alpha') }, run.io);
    expect(result.exitCode).toBe(1);
    expect('app' in result).toBe(false);
    expect(run.errors.join('')).not.toContain('db.example.test');
    expect(run.errors.join('')).not.toContain('app_user');
  });
});
