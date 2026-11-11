import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { sourcesResponseSchema } from '@neburyx/contracts';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { docker, dockerOk, dockerStream } from '../image/docker.js';
import { buildDerivedImage, composeFile, destroyAll, repository, serviceOf, Stack, type StackOptions } from './stack.js';

const IMAGE = 'neburyx-compose-test';
const TAG_A = `a-${randomBytes(3).toString('hex')}`;
const TAG_B = `b-${randomBytes(3).toString('hex')}`;
const TAG_C = `c-${randomBytes(3).toString('hex')}`;
const stacks: Stack[] = [];

/** The number after the last shipped migration, so a migration the test adds comes after every one the older image has run. */
const NEXT_MIGRATION = String(
  Math.max(...readdirSync(fileURLToPath(new URL('../../migrations', import.meta.url))).flatMap((name) => Number(/^(\d{4})-/.exec(name)?.[1] ?? Number.NaN) || [])) + 1,
).padStart(4, '0');

beforeAll(async () => {
  await dockerStream(['build', '-f', 'deploy/docker/Dockerfile', '-t', `${IMAGE}:${TAG_A}`, '.'], repository);
  await buildDerivedImage(
    `${IMAGE}:${TAG_A}`,
    `${IMAGE}:${TAG_B}`,
    `${NEXT_MIGRATION}-upgrade-marker.sql`,
    'CREATE TABLE upgrade_marker (id integer PRIMARY KEY);\nINSERT INTO upgrade_marker (id) VALUES (1);\n',
  );
  await buildDerivedImage(
    `${IMAGE}:${TAG_A}`,
    `${IMAGE}:${TAG_C}`,
    `${NEXT_MIGRATION}-broken.sql`,
    'CREATE TABLE half_done (id integer);\nSELECT * FROM table_that_does_not_exist;\n',
  );
});

afterAll(async () => {
  try {
    await destroyAll(stacks);
  } finally {
    for (const tag of [TAG_C, TAG_B, TAG_A]) await docker(['rmi', '-f', `${IMAGE}:${tag}`]);
  }
});

async function newStack(extra: { readonly omit?: readonly string[]; readonly overrides?: readonly string[]; readonly settings?: Readonly<Record<string, string>>; readonly mapping?: StackOptions['mapping'] } = {}): Promise<Stack> {
  const stack = await Stack.create({ image: IMAGE, tag: TAG_A, ...extra });
  stacks.push(stack);
  return stack;
}

async function healthOf(stack: Stack, service: string): Promise<string> {
  return dockerOk(['inspect', '--format', '{{.State.Health.Status}}', await stack.containerId(service)]);
}

describe('a settings file with a password or the cursor key missing', () => {
  it.each(['NEBURYX_DB_ADMIN_PASSWORD', 'NEBURYX_DB_MIGRATION_PASSWORD', 'NEBURYX_DB_APP_PASSWORD', 'NEBURYX_CURSOR_KEY'].flatMap((name) => [[name, 'missing'] as const, [name, 'empty'] as const]))(
    'stops docker compose up before any container exists, naming %s when it is %s',
    async (name, how) => {
      const stack = await newStack(how === 'missing' ? { omit: [name] } : { settings: { [name]: '' } });
      const result = await stack.compose(['up', '--no-start']);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(name);
      expect(await dockerOk(['ps', '-aq', '--filter', `label=com.docker.compose.project=${stack.project}`])).toBe('');
    },
  );
});

describe('a fresh install', () => {
  let stack: Stack;
  let startedAt: number;

  beforeAll(async () => {
    stack = await newStack();
    startedAt = Date.now() * 1e6;
    const result = await stack.up();
    expect(result.code, result.stderr).toBe(0);
  });

  it('answers /healthz and /v1/me with the local principal', async () => {
    expect((await fetch(`${stack.url}/healthz`)).status).toBe(200);
    const me = await fetch(`${stack.url}/v1/me`);
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ principal: { displayName: 'Local workspace', role: 'administrator' }, edition: 'community' });
  });

  it('finishes the migrate container with exit code 0 before the api container starts', async () => {
    const events = await stack.events(startedAt);
    const migrated = events.find((event) => serviceOf(event) === 'migrate' && event.Action === 'die');
    const serving = events.find((event) => serviceOf(event) === 'api' && event.Action === 'start');
    expect(migrated?.Actor.Attributes['exitCode']).toBe('0');
    expect(serving).toBeDefined();
    expect(migrated?.timeNano).toBeLessThan(serving?.timeNano ?? 0);
  });

  it('creates the database owned by the migration role, and an app role that can log in', async () => {
    expect((await stack.psql("SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = 'neburyx'")).stdout.trim()).toBe('neburyx_migrate');
    expect((await stack.psql("SELECT rolcanlogin FROM pg_roles WHERE rolname = 'neburyx_app'")).stdout.trim()).toBe('t');
    expect((await stack.psql('SELECT 1', 'neburyx_app')).stdout.trim()).toBe('1');
  });

  it('reports the api container healthy', async () => {
    expect(await healthOf(stack, 'api')).toBe('healthy');
  });

  it('does nothing the second time: migrate has nothing to apply and the local user keeps its id', async () => {
    const before = (await stack.psql("SELECT id FROM users WHERE issuer = 'local'")).stdout.trim();
    expect(before).not.toBe('');
    const again = await stack.up();
    expect(again.code, again.stderr).toBe(0);
    expect((await stack.compose(['logs', '--no-log-prefix', 'migrate'])).stdout).toContain('nothing to apply');
    expect((await stack.psql("SELECT id FROM users WHERE issuer = 'local'")).stdout.trim()).toBe(before);
  });

  it('reports the api container unhealthy while Postgres is stopped, and healthy again after it is started', async () => {
    expect((await stack.compose(['stop', 'db'])).code).toBe(0);
    await vi.waitFor(async () => expect(await healthOf(stack, 'api')).toBe('unhealthy'), { timeout: 90_000, interval: 2000 });
    expect((await fetch(`${stack.url}/readyz`)).status).toBe(503);
    expect((await stack.compose(['start', 'db'])).code).toBe(0);
    await vi.waitFor(async () => expect(await healthOf(stack, 'api')).toBe('healthy'), { timeout: 90_000, interval: 2000 });
  });
});

describe('the cursor key', () => {
  const COMPOSE_DIRECTORY = fileURLToPath(new URL('../../../../deploy/compose/', import.meta.url));

  it('is given to the api container, and the api logs no warning about a key it made itself', async () => {
    const stack = await newStack();
    expect((await stack.up()).code).toBe(0);
    const live = (await stack.compose(['exec', '-T', 'api', 'env'])).stdout;
    expect(live).toContain(`NEBURYX_CURSOR_KEY=${stack.cursorKey}`);
    const logs = (await stack.compose(['logs', '--no-log-prefix', 'api'])).stdout;
    expect(logs).not.toContain('cursor.key_not_set');
    expect(logs).not.toContain(stack.cursorKey);
  });

  it('keeps a page cursor valid across a restart of the api container', async () => {
    const stack = await newStack();
    expect((await stack.up()).code).toBe(0);
    await stack.psql(
      `INSERT INTO sources (id, alias, connector, uri, database, secret_ref, config_hash, identity_hash) VALUES ('restart-source', 'restart-source', 'neo4j', 'bolt://unused:7687', 'neo4j', 'U:P', 'c', 'i');
       INSERT INTO investigations (id, source_id, source_identity_hash, owner_id, title) SELECT gen_random_uuid(), 'restart-source', 'i', id, 'Restart ' || n FROM users, generate_series(1, 3) AS n WHERE issuer = 'local'`,
    );
    const first = await fetch(`${stack.url}/v1/investigations?limit=1`);
    expect(first.status).toBe(200);
    const body = z.object({ items: z.array(z.unknown()).length(1), nextCursor: z.string() }).parse(await first.json());

    expect((await stack.compose(['restart', 'api'])).code).toBe(0);
    await vi.waitFor(async () => expect((await fetch(`${stack.url}/readyz`)).status).toBe(200), { timeout: 60_000, interval: 1000 });

    const next = await fetch(`${stack.url}/v1/investigations?limit=1&cursor=${encodeURIComponent(body.nextCursor)}`);
    expect(next.status).toBe(200);
    expect(z.object({ items: z.array(z.unknown()).length(1) }).parse(await next.json()).items).toHaveLength(1);
  });

  it('stops the api with exit code 1 and a message that names the variable and does not repeat its value, for a key that is not a key', async () => {
    const bad = 'this-is-not-a-cursor-key-value';
    const stack = await newStack({ settings: { NEBURYX_CURSOR_KEY: bad } });
    const recorder = await stack.record();
    try {
      const since = Date.now() * 1e6;
      const result = await stack.compose(['up', '--wait', '--wait-timeout', '60']);
      expect(result.code).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).not.toContain(bad);
      await recorder.sync();
      const died = recorder.since(since).find((event) => serviceOf(event) === 'api' && event.Action === 'die');
      expect(died?.Actor.Attributes['exitCode']).toBe('1');
      const logs = (await stack.compose(['logs', '--no-log-prefix', 'api'])).stdout;
      expect(logs).toContain('invalid configuration: NEBURYX_CURSOR_KEY');
      expect(logs).not.toContain(bad);
    } finally {
      await recorder.stop();
    }
  });

  it('is explained by the settings example and the README, with the command that makes one and the rule that it is never committed', () => {
    for (const file of ['.env.example', 'README.md']) {
      const text = readFileSync(`${COMPOSE_DIRECTORY}${file}`, 'utf8');
      expect(text, file).toContain('NEBURYX_CURSOR_KEY');
      expect(text, file).toContain('openssl rand -base64 32');
      expect(text.toLowerCase(), file).toContain('never commit');
    }
  });
});

const SOURCE_ENV_FILE = join(repository, 'deploy/compose/source.env');
const SOURCE_MAPPING = `sources:
  - id: compose-source
    uri: "bolt://neo4j.unused.example:7687"
    database: neo4j
    auth: { kind: basic, username_env: COMPOSE_TEST_USER, password_env: COMPOSE_TEST_PASSWORD }
    entities:
      - type: account
        label: Account
        stable_id: accountId
`;

/** Writes `deploy/compose/source.env` for the length of one test: the file the shipped compose file reads is the one next to it. */
async function withSourceEnv<T>(text: string, run: () => Promise<T>): Promise<T> {
  writeFileSync(SOURCE_ENV_FILE, text, { mode: 0o600 });
  try {
    return await run();
  } finally {
    rmSync(SOURCE_ENV_FILE, { force: true });
  }
}

describe('the mapping and the source login', () => {
  it('stops the api with a message naming the mapping file when the config folder holds none, and starts with no sources once the example is copied', async () => {
    const missing = await newStack({ mapping: 'none' });
    const failed = await missing.compose(['up', '--wait', '--wait-timeout', '60']);
    expect(failed.code).not.toBe(0);
    const logs = (await missing.compose(['logs', '--no-log-prefix', 'api'])).stdout;
    expect(logs).toContain('/etc/neburyx/neburyx.yaml');
    expect(logs).toContain('cannot be read');

    const copied = await newStack();
    expect((await copied.up()).code).toBe(0);
    const listed = sourcesResponseSchema.parse(await (await fetch(`${copied.url}/v1/sources`)).json());
    expect(listed.items).toEqual([]);
  });

  it('starts without a source.env, and logs that the source has no credentials without logging a value', async () => {
    expect(existsSync(SOURCE_ENV_FILE)).toBe(false);
    const stack = await newStack({ mapping: { text: SOURCE_MAPPING } });
    expect((await stack.up()).code).toBe(0);
    await vi.waitFor(async () => expect((await stack.compose(['logs', '--no-log-prefix', 'api'])).stdout).toContain('source.credentials_missing'), { timeout: 60_000, interval: 1000 });
    expect((await stack.compose(['exec', '-T', 'api', 'env'])).stdout).not.toContain('COMPOSE_TEST_USER');
  });

  it('lists a source of the mounted mapping, and hands the variables of source.env to the api without any value in a committed file or in the logs', async () => {
    const user = `user-${randomBytes(6).toString('hex')}`;
    const password = `pw-${randomBytes(12).toString('hex')}`;
    await withSourceEnv(`COMPOSE_TEST_USER=${user}\nCOMPOSE_TEST_PASSWORD=${password}\n`, async () => {
      const stack = await newStack({ mapping: { text: SOURCE_MAPPING } });
      expect((await stack.up()).code).toBe(0);
      const live = (await stack.compose(['exec', '-T', 'api', 'env'])).stdout;
      expect(live).toContain('NEBURYX_CONFIG=/etc/neburyx/neburyx.yaml');
      expect(live).toContain(`COMPOSE_TEST_USER=${user}`);
      expect(live).toContain(`COMPOSE_TEST_PASSWORD=${password}`);
      const listed = sourcesResponseSchema.parse(await (await fetch(`${stack.url}/v1/sources`)).json());
      expect(listed.items.map((item) => item.id)).toEqual(['compose-source']);
      const logs = (await stack.compose(['logs', '--no-log-prefix', 'api'])).stdout;
      expect(logs).not.toContain(password);
      expect(logs).not.toContain(user);
      expect(logs).not.toContain('source.credentials_missing');
      for (const file of [composeFile, join(repository, 'deploy/compose/.env.example'), join(repository, 'deploy/compose/config/neburyx.example.yaml')]) {
        expect(readFileSync(file, 'utf8')).not.toContain(password);
      }
    });
  });

  it('reads the mapping from the folder NEBURYX_CONFIG_DIR names, mounted read-only', async () => {
    const stack = await newStack({ mapping: { text: SOURCE_MAPPING } });
    expect((await stack.up()).code).toBe(0);
    expect(await dockerOk(['inspect', '--format', '{{range .Mounts}}{{.Destination}} {{.Source}} {{.RW}}\n{{end}}', await stack.containerId('api')])).toMatch(/^\/etc\/neburyx \S+ false$/m);
    const written = await stack.compose(['exec', '-T', 'api', 'sh', '-c', 'touch /etc/neburyx/written']);
    expect(written.code).not.toBe(0);
    expect(sourcesResponseSchema.parse(await (await fetch(`${stack.url}/v1/sources`)).json()).items).toHaveLength(1);
  });

  it('is kept out of git: the mapping a reader adds and source.env are ignored', () => {
    for (const path of ['deploy/compose/config/neburyx.yaml', 'deploy/compose/source.env']) {
      expect(() => execFileSync('git', ['check-ignore', '--quiet', path], { cwd: repository }), path).not.toThrow();
    }
  });

  it('is explained by the settings example and the README: the config folder, NEBURYX_CONFIG_DIR, source.env, its mode and the Compose version it needs', () => {
    for (const file of ['.env.example', 'README.md']) {
      const text = readFileSync(join(repository, 'deploy/compose', file), 'utf8');
      for (const word of ['config/neburyx.yaml', 'NEBURYX_CONFIG_DIR', 'source.env', '0600', '2.24']) expect(text, `${file}: ${word}`).toContain(word);
    }
  });
});

/** What `compose port` prints for a port that is exposed but not published: the host part differs between Compose versions (`:0` on v2.38.2 and v5.6.0, `invalid IP:0` on v5.1.3); the host port is 0 or the line is empty. */
const NO_HOST_PORT = /^(|.*:0)$/;

describe('the published ports', () => {
  let stack: Stack;

  beforeAll(async () => {
    stack = await newStack();
    const result = await stack.up();
    expect(result.code, result.stderr).toBe(0);
  });

  const bindings = z.record(z.string(), z.array(z.object({ HostIp: z.string(), HostPort: z.string() })).nullable());

  it('binds the api port to 127.0.0.1 only, so the machine\u2019s other addresses are refused', async () => {
    const raw = await dockerOk(['inspect', '--format', '{{json .HostConfig.PortBindings}}', await stack.containerId('api')]);
    const published = Object.values(bindings.parse(JSON.parse(raw))).flatMap((list) => list ?? []);
    expect(published).toEqual([{ HostIp: '127.0.0.1', HostPort: String(stack.port) }]);

    const external = Object.values(networkInterfaces())
      .flatMap((list) => list ?? [])
      .find((entry) => entry.family === 'IPv4' && !entry.internal);
    if (external === undefined) return;
    await expect(fetch(`http://${external.address}:${stack.port}/healthz`, { signal: AbortSignal.timeout(5000) })).rejects.toThrow();
  });

  it('publishes nothing for the db service', async () => {
    const raw = await dockerOk(['inspect', '--format', '{{json .HostConfig.PortBindings}}', await stack.containerId('db')]);
    expect(Object.values(bindings.parse(JSON.parse(raw))).flatMap((list) => list ?? [])).toEqual([]);
    const found = await stack.compose(['port', 'db', '5432']);
    expect(found.stdout.trim()).toMatch(NO_HOST_PORT);
  });
});

describe('the credentials of each service', () => {
  let stack: Stack;

  beforeAll(async () => {
    stack = await newStack({ overrides: [fileURLToPath(new URL('./fixtures/connection-log.yaml', import.meta.url))] });
    const result = await stack.up();
    expect(result.code, result.stderr).toBe(0);
  });

  it('gives the api container the app role\u2019s connection string and no migration or superuser secret', async () => {
    const id = await stack.containerId('api');
    const inspected = await dockerOk(['inspect', '--format', '{{json .Config.Env}}', id]);
    const live = (await stack.compose(['exec', '-T', 'api', 'env'])).stdout;
    for (const text of [inspected, live]) {
      expect(text).toContain('DATABASE_URL=postgres://neburyx_app:');
      expect(text).not.toContain(stack.passwords.NEBURYX_DB_MIGRATION_PASSWORD);
      expect(text).not.toContain(stack.passwords.NEBURYX_DB_ADMIN_PASSWORD);
      expect(text).not.toContain('DATABASE_MIGRATION_URL');
      expect(text).not.toContain('neburyx_migrate');
    }
  });

  it('keeps export files in a volume at /data/exports, owned by the node user with mode 0700, and the api can write there', async () => {
    const mount = (await stack.compose(['exec', '-T', 'api', 'sh', '-c', 'stat -c "%a %U" /data/exports && touch /data/exports/.probe && rm /data/exports/.probe && echo writable'])).stdout.trim().split('\n');
    expect(mount).toEqual(['700 node', 'writable']);
    const id = await stack.containerId('api');
    expect(await dockerOk(['inspect', '--format', '{{range .Mounts}}{{.Destination}} {{.Type}}\n{{end}}', id])).toContain('/data/exports volume');
  });

  it('shows in the connection log that migrate used the migration role and api the app role', async () => {
    const log = (await stack.compose(['logs', '--no-log-prefix', 'db'])).stdout;
    const users = new Set([...log.matchAll(/connection authorized: user=(\S+)/g)].map((match) => match[1]));
    expect(users.has('neburyx_migrate')).toBe(true);
    expect(users.has('neburyx_app')).toBe(true);
    expect([...users].filter((user) => user !== 'neburyx_migrate' && user !== 'neburyx_app' && user !== 'postgres')).toEqual([]);
  });

  it('refuses the app role both a new table and a change to an existing one', async () => {
    const created = await stack.psql('CREATE TABLE created_by_app (id integer)', 'neburyx_app');
    expect(created.code).not.toBe(0);
    expect(created.stderr).toMatch(/permission denied/);
    const altered = await stack.psql('ALTER TABLE deployment ADD COLUMN added_by_app integer', 'neburyx_app');
    expect(altered.code).not.toBe(0);
    expect(altered.stderr).toMatch(/must be owner/);
  });
});

describe('an upgrade by changing the image tag', () => {
  async function imageOf(stack: Stack, service: string): Promise<string> {
    return dockerOk(['inspect', '--format', '{{.Config.Image}}', await stack.containerId(service)]);
  }

  async function localUser(stack: Stack): Promise<string> {
    return (await stack.psql("SELECT id || ' ' || created_at FROM users WHERE issuer = 'local'")).stdout.trim();
  }

  it('runs the new migration before the new api starts, with nothing but docker compose up, and keeps the data', async () => {
    const stack = await newStack();
    expect((await stack.up()).code).toBe(0);
    const before = await localUser(stack);
    expect(before).not.toBe('');
    expect((await stack.psql("SELECT to_regclass('upgrade_marker')")).stdout.trim()).toBe('');

    stack.setTag(TAG_B);
    const marker = Date.now() * 1e6;
    const issued = stack.commands.length;
    const upgrade = await stack.up();
    expect(upgrade.code, upgrade.stderr).toBe(0);

    expect(stack.commands.slice(issued).map((command) => command[0])).toEqual(['up']);
    expect(await imageOf(stack, 'migrate')).toBe(`${IMAGE}:${TAG_B}`);
    expect(await imageOf(stack, 'api')).toBe(`${IMAGE}:${TAG_B}`);
    const events = await stack.events(marker);
    const migrated = events.find((event) => serviceOf(event) === 'migrate' && event.Action === 'die' && event.Actor.Attributes['image'] === `${IMAGE}:${TAG_B}`);
    const serving = events.find((event) => serviceOf(event) === 'api' && event.Action === 'start' && event.Actor.Attributes['image'] === `${IMAGE}:${TAG_B}`);
    expect(migrated?.Actor.Attributes['exitCode']).toBe('0');
    expect(migrated?.timeNano).toBeLessThan(serving?.timeNano ?? 0);

    expect((await stack.psql('SELECT count(*) FROM upgrade_marker')).stdout.trim()).toBe('1');
    expect(await localUser(stack)).toBe(before);
    const ready = await fetch(`${stack.url}/readyz`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: 'ready', checks: { database: 'ok', migrations: 'ok' }, sources: { reachable: 0, unreachable: 0, unknown: 0 } });
  });

  it('stops at a failing migration without starting the new api, leaves the database as it was, and recovers on the working image', async () => {
    const stack = await newStack();
    expect((await stack.up()).code).toBe(0);
    const before = await localUser(stack);

    stack.setTag(TAG_C);
    const marker = Date.now() * 1e6;
    const failed = await stack.compose(['up', '--wait', '--wait-timeout', '60']);
    expect(failed.code).not.toBe(0);
    expect(await dockerOk(['inspect', '--format', '{{.State.ExitCode}}', await stack.containerId('migrate')])).not.toBe('0');
    const events = await stack.events(marker);
    expect(events.filter((event) => serviceOf(event) === 'api' && event.Action === 'start' && event.Actor.Attributes['image'] === `${IMAGE}:${TAG_C}`)).toEqual([]);
    expect(await dockerOk(['inspect', '--format', '{{.State.Running}}', await stack.containerId('api')])).toBe('false');
    expect((await stack.psql("SELECT to_regclass('half_done')")).stdout.trim()).toBe('');
    expect(await localUser(stack)).toBe(before);

    stack.setTag(TAG_A);
    const recovered = await stack.up();
    expect(recovered.code, recovered.stderr).toBe(0);
    expect((await fetch(`${stack.url}/readyz`)).status).toBe(200);
    expect(await localUser(stack)).toBe(before);
  });
});
