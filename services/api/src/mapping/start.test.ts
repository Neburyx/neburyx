import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { start, type StartIo } from '../start.js';
import { memoryAppStore } from '../testing/app-store.js';
import { baseSource, fileOf, REFUSED_MARKER, REFUSED_YAML, type Json } from '../testing/mapping.js';
import { makeWebRoot } from '../testing/web-root.js';

const webRoot = makeWebRoot();
const folder = mkdtempSync(join(tmpdir(), 'start-mapping-'));
afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
  rmSync(folder, { recursive: true, force: true });
});

const DATABASE_ENV = { DATABASE_URL: 'postgres://app_user@db.example.test:5432/neburyx' };

function run(): { readonly io: StartIo; readonly errors: string[]; readonly openStore: ReturnType<typeof vi.fn> } {
  const errors: string[] = [];
  const openStore = vi.fn(memoryAppStore);
  return {
    errors,
    openStore,
    io: { stderr: { write: (text) => errors.push(text) }, logger: pino({ level: 'silent' }), defaultWebRoot: webRoot, openStore, tasks: [], portOverride: 0 },
  };
}

let counter = 0;
function writeMapping(text: string): string {
  counter += 1;
  const file = join(folder, `neburyx-${counter}.yaml`);
  writeFileSync(file, text);
  return file;
}

async function refused(text: string): Promise<{ readonly message: string; readonly openStore: ReturnType<typeof vi.fn>; readonly exitCode: number; readonly hasApp: boolean }> {
  const attempt = run();
  const result = await start({ ...DATABASE_ENV, NEBURYX_CONFIG: writeMapping(text) }, attempt.io);
  return { message: attempt.errors.join(''), openStore: attempt.openStore, exitCode: result.exitCode, hasApp: 'app' in result };
}

describe('start-up with a mapping file', () => {
  it('refuses a retention value out of range, naming the key, and does not open the store', async () => {
    const outcome = await refused(`${fileOf(baseSource())}retention:\n  deleted_investigations_days: 0\n`);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.message).toContain('retention.deleted_investigations_days');
    expect(outcome.openStore).not.toHaveBeenCalled();
  });

  it('starts as before when NEBURYX_CONFIG is not set', async () => {
    const attempt = run();
    const result = await start({ ...DATABASE_ENV }, attempt.io);
    expect(result.exitCode).toBe(0);
    if (result.exitCode === 0) await result.app.close();
  });

  it('starts when the mapping is valid', async () => {
    const attempt = run();
    const result = await start({ ...DATABASE_ENV, NEBURYX_CONFIG: writeMapping(fileOf(baseSource())) }, attempt.io);
    expect(result.exitCode).toBe(0);
    if (result.exitCode === 0) await result.app.close();
  });

  it('exits 1 naming NEBURYX_CONFIG when it is set to an empty value', async () => {
    const attempt = run();
    const result = await start({ ...DATABASE_ENV, NEBURYX_CONFIG: '' }, attempt.io);
    expect(result.exitCode).toBe(1);
    expect(attempt.errors.join('')).toContain('NEBURYX_CONFIG');
  });

  it('exits 1 naming the path of a file that does not exist, with no listener and no store', async () => {
    const attempt = run();
    const missing = join(folder, 'missing.yaml');
    const result = await start({ ...DATABASE_ENV, NEBURYX_CONFIG: missing }, attempt.io);
    expect(result.exitCode).toBe(1);
    expect('app' in result).toBe(false);
    expect(attempt.errors.join('')).toContain(missing);
    expect(attempt.openStore).not.toHaveBeenCalled();
  });

  it('exits 1 with the line and column of a syntax error, with no listener and no store', async () => {
    const outcome = await refused('sources:\n  - id: demo\n   bad: indent\n');
    expect(outcome.exitCode).toBe(1);
    expect(outcome.hasApp).toBe(false);
    expect(outcome.message).toMatch(/line \d+, column \d+/);
    expect(outcome.openStore).not.toHaveBeenCalled();
  });
});

const mistakes: readonly [string, Json, string][] = [
  ['a duplicate entity type', baseSource({ entities: [{ type: 'node_a', label: 'A', stable_id: 'id' }, { type: 'node_a', label: 'B', stable_id: 'id' }], relationships: undefined }), 'sources[0].entities[1].type'],
  ['an unmapped relationship endpoint', baseSource({ relationships: [{ type: 'LINKS', from: 'node_a', to: 'missing' }] }), 'sources[0].relationships[0].to'],
  ['an unmapped derived entry', baseSource({ derived: [{ id: 'r', from: 'node_a', to: 'node_a', via: ['LINKS', 'missing', 'LINKS'], rule_version: 1 }] }), 'sources[0].derived[0].via[1]'],
  ['a bad preset', baseSource({ patterns: [{ id: 'p', name: 'P', template: 'shared-attribute', bind: { anchor: 'node_a' } }] }), 'sources[0].patterns[0].bind'],
  ['a budget above its ceiling', baseSource({ budgets: { max_page: 500 } }), 'sources[0].budgets.max_page'],
  ['a uri with user-info', baseSource({ uri: 'neo4j://reader:pw@host.example.test' }), 'sources[0].uri'],
  ['a link with the wrong scheme', baseSource({ entities: [{ type: 'node_a', label: 'A', stable_id: 'id', link: 'http://records.example.test/{id}' }], relationships: undefined }), 'sources[0].entities[0].link'],
  ['a link with a host placeholder', baseSource({ entities: [{ type: 'node_a', label: 'A', stable_id: 'id', link: 'https://{id}.example.test/x' }], relationships: undefined }), 'sources[0].entities[0].link'],
  ['a link with a pii placeholder', baseSource({ entities: [{ type: 'node_a', label: 'A', stable_id: 'id', pii: ['id'], link: 'https://records.example.test/{id}' }], relationships: undefined }), 'sources[0].entities[0].link'],
];

describe('start-up refused for a mapping mistake', () => {
  it.each(mistakes)('exits 1 for %s, names its place, opens no store and no listener', async (_name, source, path) => {
    const outcome = await refused(fileOf(source));
    expect(outcome.exitCode).toBe(1);
    expect(outcome.hasApp).toBe(false);
    expect(outcome.message).toContain(path);
    expect(outcome.message).toMatch(/line \d+/);
    expect(outcome.openStore).not.toHaveBeenCalled();
  });

  it('names a marked-pii placeholder', async () => {
    const outcome = await refused(fileOf(mistakes.find(([name]) => name === 'a link with a pii placeholder')?.[1] ?? {}));
    expect(outcome.message).toContain('which is marked pii');
  });

  it.each(REFUSED_YAML)('exits 1 for %s, with its place, no store, no listener and no value', async (_name, text, reason) => {
    const outcome = await refused(text);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.hasApp).toBe(false);
    expect(outcome.openStore).not.toHaveBeenCalled();
    expect(outcome.message).toContain(reason);
    expect(outcome.message).toMatch(/line \d+, column \d+/);
    expect(outcome.message).not.toContain(REFUSED_MARKER);
  });

  it('never prints the address or credential names of the file', async () => {
    const outcome = await refused(fileOf(baseSource({ uri: 'neo4j://reader:hunter2@private-host.example.test', auth: { kind: 'basic', username_env: 'PRIVATE_USER_VAR', password_env: 'PRIVATE_PASSWORD_VAR' } })));
    for (const secret of ['hunter2', 'private-host', 'PRIVATE_USER_VAR', 'PRIVATE_PASSWORD_VAR']) expect(outcome.message).not.toContain(secret);
  });
});

describe('start-up with a source whose ID the API paths take', () => {
  it('does not start, names the key and why, and does not open the store', async () => {
    const result = await refused(fileOf(baseSource({ id: 'v1' })));
    expect(result.exitCode).not.toBe(0);
    expect(result.hasApp).toBe(false);
    expect(result.message).toContain('sources[0].id');
    expect(result.message).toContain('first segment of the paths the API answers');
    expect(result.openStore).not.toHaveBeenCalled();
  });
});
