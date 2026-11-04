import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { docker, dockerOk, dockerStream } from '../image/docker.js';
import { buildDerivedImage, destroyAll, repository, serviceOf, Stack } from './stack.js';

const IMAGE = 'neburyx-compose-test';
const TAG_A = `a-${randomBytes(3).toString('hex')}`;
const TAG_B = `b-${randomBytes(3).toString('hex')}`;
const TAG_C = `c-${randomBytes(3).toString('hex')}`;
const stacks: Stack[] = [];

beforeAll(async () => {
  await dockerStream(['build', '-f', 'deploy/docker/Dockerfile', '-t', `${IMAGE}:${TAG_A}`, '.'], repository);
  await buildDerivedImage(
    `${IMAGE}:${TAG_A}`,
    `${IMAGE}:${TAG_B}`,
    '0008-upgrade-marker.sql',
    'CREATE TABLE upgrade_marker (id integer PRIMARY KEY);\nINSERT INTO upgrade_marker (id) VALUES (1);\n',
  );
  await buildDerivedImage(
    `${IMAGE}:${TAG_A}`,
    `${IMAGE}:${TAG_C}`,
    '0008-broken.sql',
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

async function newStack(extra: { readonly omit?: readonly string[]; readonly overrides?: readonly string[] } = {}): Promise<Stack> {
  const stack = await Stack.create({ image: IMAGE, tag: TAG_A, ...extra });
  stacks.push(stack);
  return stack;
}

async function healthOf(stack: Stack, service: string): Promise<string> {
  return dockerOk(['inspect', '--format', '{{.State.Health.Status}}', await stack.containerId(service)]);
}

describe('a settings file with a password missing', () => {
  it.each(['NEBURYX_DB_ADMIN_PASSWORD', 'NEBURYX_DB_MIGRATION_PASSWORD', 'NEBURYX_DB_APP_PASSWORD'])(
    'stops docker compose up before any container exists, naming %s',
    async (name) => {
      const stack = await newStack({ omit: [name] });
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
