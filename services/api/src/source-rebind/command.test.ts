import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { InvestigationRow } from '../db/investigations-repository.js';
import { parseMapping } from '../mapping/load.js';
import { identityHashOf } from '../registry/identity-hash.js';
import { memoryStoreWith, type MemoryAppStore, type MemoryAppStoreOptions } from '../testing/app-store.js';
import { sourceWith } from '../testing/gate-fixtures.js';
import { fileOf } from '../testing/mapping.js';
import { reportFromServer } from '../source-test/report.js';
import { runSourceRebindCommand, type RebindIo } from './command.js';

const folder = mkdtempSync(join(tmpdir(), 'source-rebind-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

const DATABASE_URL = 'postgres://app_user:MARKER_DB_PASSWORD@db.example.test:5432/neburyx';
const URI = 'neo4j+s://MARKER_HOST.example.test:7687';
const AUTH = { kind: 'basic', username_env: 'MARKER_USER_VAR', password_env: 'MARKER_PASS_VAR' };
const SECRET_ENV = { MARKER_USER_VAR: 'MARKER_USER_VALUE', MARKER_PASS_VAR: 'MARKER_PASS_VALUE' };
const LEAKS = ['MARKER_DB_PASSWORD', 'MARKER_HOST', 'MARKER_USER', 'MARKER_PASS', 'db.example.test', 'app_user', 'neo4j+s', 'MARKER_DB_NAME'];

let counter = 0;
const mappingYaml = (...ids: string[]) => fileOf(...ids.map((id) => sourceWith(id, { uri: URI, database: 'MARKER_DB_NAME', auth: AUTH })));
function mappingFile(...ids: string[]): string {
  counter += 1;
  const file = join(folder, `neburyx-${counter}.yaml`);
  writeFileSync(file, mappingYaml(...ids));
  return file;
}
const mapping = parseMapping(mappingYaml('alpha', 'beta'), 'neburyx.yaml');
const [alpha, beta] = mapping.sources;
if (alpha === undefined || beta === undefined) throw new Error('the fixture has two sources');
const CURRENT = identityHashOf(alpha);

const environment = (extra: Record<string, string | undefined> = {}) => ({ DATABASE_URL, NEBURYX_CONFIG: mappingFile('alpha', 'beta'), ...SECRET_ENV, ...extra });
const server = { product: 'Neo4j Kernel', version: '5.26.32', edition: 'community', versionSupported: true, operations: [] };

function investigation(id: string, sourceId: string, hash: string): InvestigationRow {
  return { id, sourceId, sourceIdentityHash: hash, ownerId: 'me', title: 'T', caseRef: null, startingEntityType: null, startingStableId: null, status: 'open', closedAt: null, archivedAt: null, createdAt: '2026-11-05T10:00:00.000Z', lastEditedAt: '2026-11-05T10:00:00.000Z', version: 1 };
}

interface Setup {
  readonly options?: MemoryAppStoreOptions;
  readonly tested?: boolean;
}

function storeOf({ options = {}, tested = true }: Setup = {}): MemoryAppStore {
  const store = memoryStoreWith({ sources: [alpha, beta].map((source) => ({ id: source.id, alias: source.id, state: 'unknown', stateReason: null, synthetic: false, lastTestAt: null })), ...options });
  store.investigations.push(investigation('i1', 'alpha', 'old-hash'), investigation('i2', 'alpha', CURRENT), investigation('i3', 'alpha', 'older-hash'), investigation('i4', 'beta', 'beta-old'));
  if (tested) void store.recordSourceCheck({ id: 'c1', report: reportFromServer(alpha, server, false, '2026-11-09T10:00:00.000Z'), triggeredBy: null, identityHash: CURRENT, configHash: alpha.configHash });
  return store;
}

interface Run {
  readonly code: number;
  readonly out: string;
  readonly err: string;
  readonly store: MemoryAppStore;
  readonly asked: string[];
  readonly closed: number;
}

async function run(args: readonly string[], env: Record<string, string | undefined> = environment(), store: MemoryAppStore = storeOf(), io: Partial<RebindIo> = {}): Promise<Run> {
  let out = '';
  let err = '';
  let closed = 0;
  const asked: string[] = [];
  const code = await runSourceRebindCommand(args, env, {
    stdout: { write: (text) => (out += text) },
    stderr: { write: (text) => (err += text) },
    openStore: () => ({ rebindSource: store.rebindSource, close: () => { closed += 1; return Promise.resolve(); } }),
    ...io,
  });
  return { code, out, err, store, asked, closed };
}

const hashes = (store: MemoryAppStore) => store.investigations.map((row) => [row.id, row.sourceIdentityHash]);
const noLeak = (result: Run) => {
  for (const marker of LEAKS) expect(result.out + result.err).not.toContain(marker);
  expect(result.out + result.err).not.toContain(CURRENT);
  expect(result.out + result.err).not.toMatch(/[0-9a-f]{40,}/);
};

describe('a usage error or a confirmation that does not match', () => {
  it.each([
    [[]],
    [['rebind']],
    [['rebind', 'alpha', 'extra']],
    [['rebind', 'alpha', '--confirm']],
    [['rebind', 'alpha', '--confirm', 'alpha', 'extra']],
    [['rebind', 'alpha', '--force', 'alpha']],
    [['rebound', 'alpha']],
    [['rebind', '--confirm', 'alpha']],
  ])('exits 2 with the usage and writes nothing for %j', async (args) => {
    const store = storeOf();
    const before = JSON.stringify(hashes(store));
    const result = await run(args, environment(), store);
    expect(result.code).toBe(2);
    expect(result.err).toContain('usage: neburyx source rebind <source> [--confirm <source>]');
    expect(JSON.stringify(hashes(store))).toBe(before);
    noLeak(result);
  });

  it.each([[['rebind', 'alpha', '--confirm', 'alph']], [['rebind', 'alpha', '--confirm', 'Alpha']], [['rebind', 'alpha', '--confirm', 'beta']], [['rebind', 'alpha', '--confirm', 'alpha ']]])('exits 2 and writes nothing when the confirmation differs: %j', async (args) => {
    const store = storeOf();
    const before = JSON.stringify(hashes(store));
    const result = await run(args, environment(), store);
    expect(result.code).toBe(2);
    expect(result.err).toContain('the confirmation does not match');
    expect(JSON.stringify(hashes(store))).toBe(before);
    noLeak(result);
  });

  it('asks on a terminal and takes the answer as the confirmation, and with no terminal and no flag exits 2', async () => {
    const asked: string[] = [];
    const yes = await run(['rebind', 'alpha'], environment(), storeOf(), { ask: (question) => { asked.push(question); return Promise.resolve('alpha'); } });
    expect(yes.code).toBe(0);
    expect(asked).toEqual(['Type the source ID alpha again to confirm: ']);
    const wrong = await run(['rebind', 'alpha'], environment(), storeOf(), { ask: () => Promise.resolve('beta') });
    expect(wrong.code).toBe(2);
    const none = await run(['rebind', 'alpha']);
    expect(none.code).toBe(2);
    expect(none.err).toContain('pass --confirm');
  });
});

describe('a source that is not configured', () => {
  it.each([['gamma'], ['Alpha'], ['alph'], ['alpha2']])('exits 1 with "no such source" and writes nothing for %s', async (id) => {
    const store = storeOf();
    const before = JSON.stringify(hashes(store));
    const result = await run(['rebind', id, '--confirm', id], environment(), store);
    expect(result.code).toBe(1);
    expect(result.err).toBe(`no such source: ${id}\n`);
    expect(JSON.stringify(hashes(store))).toBe(before);
    expect(result.closed).toBe(0);
    noLeak(result);
  });

  it('exits 1 for a source the database holds as removed', async () => {
    const store = storeOf({ options: { inactiveSources: ['alpha'] } });
    const before = JSON.stringify(hashes(store));
    const result = await run(['rebind', 'alpha', '--confirm', 'alpha'], environment(), store);
    expect(result.code).toBe(1);
    expect(result.err).toBe('no such source: alpha\n');
    expect(JSON.stringify(hashes(store))).toBe(before);
  });
});

describe('what must be proved first', () => {
  it('exits 1 and writes nothing when the database holds another identity hash for the source', async () => {
    const store = storeOf({ options: { storedIdentityHashes: { alpha: 'a-stale-hash' } } });
    const before = JSON.stringify(hashes(store));
    const result = await run(['rebind', 'alpha', '--confirm', 'alpha'], environment(), store);
    expect(result.code).toBe(1);
    expect(result.err).toBe('the database does not hold this connection yet; start the API once so that it syncs the source, then run this again\n');
    expect(JSON.stringify(hashes(store))).toBe(before);
    noLeak(result);
  });

  it('exits 1 naming test-source when no stored check reached the source on this connection', async () => {
    const store = storeOf({ tested: false });
    const before = JSON.stringify(hashes(store));
    const result = await run(['rebind', 'alpha', '--confirm', 'alpha'], environment(), store);
    expect(result.code).toBe(1);
    expect(result.err).toBe('this connection has not been tested; run neburyx test-source --name alpha first, then run this again\n');
    expect(JSON.stringify(hashes(store))).toBe(before);
    noLeak(result);
  });

  it('does not count a check of another connection or one that did not reach the source', async () => {
    const other = storeOf({ tested: false });
    void other.recordSourceCheck({ id: 'c2', report: reportFromServer(alpha, server, false, '2026-11-09T10:00:00.000Z'), triggeredBy: null, identityHash: 'the-previous-connection', configHash: alpha.configHash });
    const unreached = { ...reportFromServer(alpha, server, false, '2026-11-09T10:00:00.000Z'), server: null };
    void other.recordSourceCheck({ id: 'c3', report: unreached, triggeredBy: null, identityHash: CURRENT, configHash: alpha.configHash });
    const result = await run(['rebind', 'alpha', '--confirm', 'alpha'], environment(), other);
    expect(result.code).toBe(1);
    expect(result.err).toContain('has not been tested');
  });
});

describe('a rebind that is proved', () => {
  it('sets the hash of every investigation of that source whose hash differs and nothing else, and says how many', async () => {
    const store = storeOf();
    const result = await run(['rebind', 'alpha', '--confirm', 'alpha'], environment(), store);
    expect(result.code).toBe(0);
    expect(result.out).toBe('Source: alpha\nInvestigations rebound: 2\n');
    expect(result.err).toBe('');
    expect(hashes(store)).toEqual([['i1', CURRENT], ['i2', CURRENT], ['i3', CURRENT], ['i4', 'beta-old']]);
    expect(store.investigations.map((row) => [row.version, row.title, row.status])).toEqual([[1, 'T', 'open'], [1, 'T', 'open'], [1, 'T', 'open'], [1, 'T', 'open']]);
    expect(result.closed).toBe(1);
    noLeak(result);
  });

  it('takes the flag before the source ID', async () => {
    const result = await run(['rebind', '--confirm', 'alpha', 'alpha']);
    expect(result.code).toBe(0);
  });

  it('reports 0 rebound and exits 0 on a second run', async () => {
    const store = storeOf();
    await run(['rebind', 'alpha', '--confirm', 'alpha'], environment(), store);
    const again = await run(['rebind', 'alpha', '--confirm', 'alpha'], environment(), store);
    expect(again.code).toBe(0);
    expect(again.out).toBe('Source: alpha\nInvestigations rebound: 0\n');
  });
});

describe('a failure', () => {
  it('exits 1 with a plain sentence and no detail of the connection when the database fails, and closes the store', async () => {
    const store = storeOf({ options: { failRebind: true } });
    const result = await run(['rebind', 'alpha', '--confirm', 'alpha'], environment(), store);
    expect(result.code).toBe(1);
    expect(result.err).toBe('the source could not be rebound; nothing was changed\n');
    expect(result.closed).toBe(1);
    noLeak(result);
  });

  it.each([[{ code: 'ECONNREFUSED' }, 'the database could not be reached\n'], [{ code: '42P01' }, 'the database schema is behind this version; run neburyx migrate\n'], [{ code: '42703' }, 'the database schema is behind this version; run neburyx migrate\n']])('says what test-source says for the database error %j, and writes nothing', async (error, sentence) => {
    const store = storeOf();
    const result = await run(['rebind', 'alpha', '--confirm', 'alpha'], environment(), store, { openStore: () => ({ rebindSource: () => Promise.reject(error), close: () => Promise.resolve() }) });
    expect(result.code).toBe(1);
    expect(result.err).toBe(sentence);
    noLeak(result);
  });

  it('exits 1 naming the variables and no value when the settings are missing', async () => {
    const result = await run(['rebind', 'alpha', '--confirm', 'alpha'], { ...environment(), DATABASE_URL: undefined });
    expect(result.code).toBe(1);
    expect(result.err).toContain('DATABASE_URL');
    noLeak(result);
  });

  it('exits 1 when the mapping path is missing, and with a fixed sentence when the mapping cannot be loaded', async () => {
    const missing = await run(['rebind', 'alpha', '--confirm', 'alpha'], { ...environment(), NEBURYX_CONFIG: undefined });
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('NEBURYX_CONFIG');
    counter += 1;
    const broken = join(folder, `broken-${counter}.yaml`);
    writeFileSync(broken, 'sources: [ MARKER_HOST.example.test');
    const bad = await run(['rebind', 'alpha', '--confirm', 'alpha'], { ...environment(), NEBURYX_CONFIG: broken });
    expect(bad.code).toBe(1);
    expect(bad.err).toBe('the mapping file could not be loaded; neburyx test-source shows why\n');
    noLeak(bad);
  });
});
