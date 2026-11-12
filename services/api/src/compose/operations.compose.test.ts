/**
 * The operations an operator does with the shipped image: install it fresh, go back one image tag, and change a
 * source's database login. Each runs through Docker Compose on the published files and nothing else.
 *
 * Rollback: there is no earlier release yet, so the "newer" image is the build under test plus one migration the
 * "older" image (the build itself) does not ship. This is a stand-in for a real previous tag; once a tag exists the
 * rollback test runs against it.
 *
 * Rotation: the Community file has no source of its own yet, so the test runs on the demo stack, which has sources,
 * graphs and a mapping. The run that is recorded as the proof of rotation uses the Community file with a graph server
 * added, once that file can carry a source.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sourcesResponseSchema } from '@neburyx/contracts';
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { docker, dockerOk, dockerStream } from '../image/docker.js';
import { buildDerivedImage, DEMO_WAIT_SECONDS, demoComposeFile, destroyAll, maskSecrets, repository, serviceOf, Stack } from './stack.js';

const IMAGE = 'neburyx-operations-test';
const LOADER_IMAGE = `neburyx-operations-loader-test:${randomBytes(3).toString('hex')}`;
const TAG = `o-${randomBytes(3).toString('hex')}`;
const TAG_NEWER = `n-${randomBytes(3).toString('hex')}`;
const TAG_EARLY = `e-${randomBytes(3).toString('hex')}`;
const STACK_TEST_TIMEOUT_MS = 900_000;
const stacks: Stack[] = [];

const NEXT_MIGRATION = String(
  Math.max(...readdirSync(fileURLToPath(new URL('../../migrations', import.meta.url))).flatMap((name) => Number(/^(\d{4})-/.exec(name)?.[1] ?? Number.NaN) || [])) + 1,
).padStart(4, '0');
const EARLY_MIGRATION = '0000-sorts-before-every-applied-migration';

const READY = { status: 'ready', checks: { database: 'ok', migrations: 'ok' }, sources: { reachable: 0, unreachable: 0, unknown: 0 } };

beforeAll(async () => {
  await dockerStream(['build', '-f', 'deploy/docker/Dockerfile', '-t', `${IMAGE}:${TAG}`, '.'], repository);
  await buildDerivedImage(`${IMAGE}:${TAG}`, `${IMAGE}:${TAG_NEWER}`, `${NEXT_MIGRATION}-newer-marker.sql`, 'CREATE TABLE newer_marker (id integer PRIMARY KEY);\nINSERT INTO newer_marker (id) VALUES (1);\n');
  await buildDerivedImage(`${IMAGE}:${TAG}`, `${IMAGE}:${TAG_EARLY}`, `${EARLY_MIGRATION}.sql`, 'CREATE TABLE sorts_early_marker (id integer);\n');
  await dockerStream(['build', '-f', 'deploy/demo/loader.Dockerfile', '-t', LOADER_IMAGE, '.'], repository);
});

afterAll(async () => {
  try {
    await destroyAll(stacks);
  } finally {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository }).toString().trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: repository }).toString().trim() === '' ? '' : ' with uncommitted changes';
    const imageId = await dockerOk(['image', 'inspect', '--format', '{{.Id}}', `${IMAGE}:${TAG}`]).catch(() => 'removed');
    process.stdout.write(`operations suite: working tree at ${head}${dirty}, image ${imageId}\n`);
    for (const tag of [TAG_EARLY, TAG_NEWER, TAG]) await docker(['rmi', '-f', `${IMAGE}:${tag}`]);
    await docker(['rmi', '-f', LOADER_IMAGE]);
  }
});

function settingsFile(): Record<string, string> {
  return { NEBURYX_CURSOR_KEY: randomBytes(32).toString('base64') };
}

async function newStack(extra: { readonly omit?: readonly string[]; readonly tag?: string; readonly settings?: Readonly<Record<string, string>> } = {}): Promise<Stack> {
  const stack = await Stack.create({ image: IMAGE, tag: extra.tag ?? TAG, settings: { ...settingsFile(), ...extra.settings }, ...(extra.omit === undefined ? {} : { omit: extra.omit }) });
  stacks.push(stack);
  return stack;
}

async function healthOf(stack: Stack, service: string): Promise<string> {
  return dockerOk(['inspect', '--format', '{{.State.Health.Status}}', await stack.containerId(service)]);
}

async function imageOf(stack: Stack, service: string): Promise<string> {
  return dockerOk(['inspect', '--format', '{{.Config.Image}}', await stack.containerId(service)]);
}

async function localUser(stack: Stack): Promise<string> {
  return (await stack.psql("SELECT id || ' ' || created_at FROM users WHERE issuer = 'local'")).stdout.trim();
}

/** The tables of the public schema and the applied migrations: what "left as it was" means. */
async function databaseState(stack: Stack): Promise<string> {
  const tables = (await stack.psql("SELECT string_agg(table_name, ',' ORDER BY table_name) FROM information_schema.tables WHERE table_schema = 'public'")).stdout.trim();
  const history = (await stack.psql("SELECT string_agg(name, ',' ORDER BY name) FROM kysely_migration")).stdout.trim();
  return `${tables}\n${history}`;
}

async function readyz(stack: Stack): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${stack.url}/readyz`);
  return { status: response.status, body: await response.json() };
}

const REQUIRED_VALUES = ['NEBURYX_DB_ADMIN_PASSWORD', 'NEBURYX_DB_MIGRATION_PASSWORD', 'NEBURYX_DB_APP_PASSWORD', 'NEBURYX_CURSOR_KEY'];

describe('a settings file with a password or the cursor key missing', () => {
  it.each(REQUIRED_VALUES.flatMap((name) => [[name, 'missing'] as const, [name, 'empty'] as const]))(
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
    expect(await dockerOk(['ps', '-aq', '--filter', `label=com.docker.compose.project=${stack.project}`])).toBe('');
    expect(await dockerOk(['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${stack.project}`])).toBe('');
    startedAt = Date.now() * 1e6;
    const result = await stack.up();
    expect(result.code, result.stderr).toBe(0);
  });

  it('answers /readyz with exactly the ready body, /healthz and /v1/me with the local principal', async () => {
    expect(await readyz(stack)).toEqual({ status: 200, body: READY });
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
    const before = await localUser(stack);
    expect(before).not.toBe('');
    const again = await stack.up();
    expect(again.code, again.stderr).toBe(0);
    expect((await stack.compose(['logs', '--no-log-prefix', 'migrate'])).stdout).toContain('nothing to apply');
    expect(await localUser(stack)).toBe(before);
  });

  it('reports the api container unhealthy while Postgres is stopped, and healthy again after it is started', async () => {
    expect((await stack.compose(['stop', 'db'])).code).toBe(0);
    await vi.waitFor(async () => expect(await healthOf(stack, 'api')).toBe('unhealthy'), { timeout: 90_000, interval: 2000 });
    expect((await fetch(`${stack.url}/readyz`)).status).toBe(503);
    expect((await stack.compose(['start', 'db'])).code).toBe(0);
    await vi.waitFor(async () => expect(await healthOf(stack, 'api')).toBe('healthy'), { timeout: 90_000, interval: 2000 });
  });
});

describe('a rollback by one image tag', () => {
  it('starts on the older image, applies nothing, keeps the data the newer image added, and is ready', async () => {
    const stack = await newStack({ tag: TAG_NEWER });
    expect((await stack.up()).code).toBe(0);
    const before = await localUser(stack);
    expect((await stack.psql('SELECT count(*) FROM newer_marker')).stdout.trim()).toBe('1');

    stack.setTag(TAG);
    const rolled = await stack.up();
    expect(rolled.code, rolled.stderr).toBe(0);

    expect(await imageOf(stack, 'migrate')).toBe(`${IMAGE}:${TAG}`);
    expect(await imageOf(stack, 'api')).toBe(`${IMAGE}:${TAG}`);
    expect(await readyz(stack)).toEqual({ status: 200, body: READY });
    expect((await stack.compose(['logs', '--no-log-prefix', 'migrate'])).stdout).toContain('nothing to apply');
    expect((await stack.psql('SELECT count(*) FROM newer_marker')).stdout.trim()).toBe('1');
    expect(await localUser(stack)).toBe(before);
  });

  it('stops at the migrate step, names the file, starts no api and changes nothing when the older image has a file that sorts before an applied one, and recovers on the newer image', async () => {
    const stack = await newStack({ tag: TAG_NEWER });
    expect((await stack.up()).code).toBe(0);
    const before = await databaseState(stack);
    expect(before).not.toContain(EARLY_MIGRATION);

    const recorder = await stack.record();
    onTestFinished(() => recorder.stop());
    stack.setTag(TAG_EARLY);
    const marker = Date.now() * 1e6;
    const refused = await stack.compose(['up', '--wait', '--wait-timeout', '60']);
    expect(refused.code).not.toBe(0);
    expect(await dockerOk(['inspect', '--format', '{{.State.ExitCode}}', await stack.containerId('migrate')])).not.toBe('0');
    const log = (await stack.compose(['logs', '--no-log-prefix', 'migrate'])).stdout;
    expect(log).toContain(EARLY_MIGRATION);
    for (const text of ['sorts_early_marker', 'CREATE TABLE']) expect(log).not.toContain(text);
    await recorder.sync();
    const events = recorder.since(marker);
    expect(events.some((event) => serviceOf(event) === 'migrate' && event.Action === 'die'), 'the recorder saw the migrate container end').toBe(true);
    expect(events.filter((event) => serviceOf(event) === 'api' && event.Action === 'start' && event.Actor.Attributes['image'] === `${IMAGE}:${TAG_EARLY}`)).toEqual([]);
    expect(await databaseState(stack)).toBe(before);

    stack.setTag(TAG_NEWER);
    const recovered = await stack.up();
    expect(recovered.code, recovered.stderr).toBe(0);
    expect((await readyz(stack)).status).toBe(200);
  });
});

describe('a change of the login a source uses', () => {
  const SOURCES = ['banking-demo', 'insurance-demo'];
  const REFUSED = 'The source refused the sign-in.';
  const initial = randomBytes(12).toString('hex');
  const rotated = randomBytes(12).toString('hex');
  const wrong = randomBytes(12).toString('hex');
  const bodies: string[] = [];
  const GRAPHS = ['demo-banking-graph', 'demo-insurance-graph'];
  let stack: Stack;

  function testSource(name: string) {
    return stack.compose(['exec', '-T', 'api', 'node', 'dist/cli.js', 'test-source', '--name', name]);
  }

  function cypherShell(graph: string, password: string, database: string, statement: string) {
    return stack.compose(['exec', '-T', '-e', `PASSWORD=${password}`, graph, 'sh', '-c', 'cypher-shell -u neo4j -p "$PASSWORD" -d "$1" --format plain "$2"', 'sh', database, statement]);
  }

  async function states(): Promise<Record<string, { state: string; reason: string | null }>> {
    const text = await (await fetch(`${stack.url}/v1/sources`)).text();
    bodies.push(text);
    const body = sourcesResponseSchema.parse(JSON.parse(text));
    return Object.fromEntries(body.items.map((item) => [item.id, { state: item.state, reason: item.stateReason }]));
  }

  /** The failed sign-ins of the old password lock the login for a few seconds (the server's own default), so a correct sign-in is retried until the lock has passed. */
  async function nodeCounts(): Promise<readonly number[]> {
    return Promise.all(
      GRAPHS.map(async (graph) => {
        let count = Number.NaN;
        await vi.waitFor(
          async () => {
            const result = await cypherShell(graph, rotated, 'neo4j', 'MATCH (n) RETURN count(n)');
            expect(result.code, result.stderr).toBe(0);
            count = Number(result.stdout.trim().split('\n').at(-1));
          },
          { timeout: 60_000, interval: 2000 },
        );
        return count;
      }),
    );
  }

  async function containerIds(): Promise<readonly string[]> {
    return Promise.all(GRAPHS.map((graph) => stack.containerId(graph)));
  }

  /** On a timeout, prints the states and the source events of the api's log (start-up checks, ping outcomes, refused sign-ins with the server's code, first-contact checks, failed state writes) with the three passwords masked, so a failure on a machine that is not at hand says why. */
  async function expectBothConnected(timeout: number): Promise<void> {
    try {
      await vi.waitFor(async () => expect(Object.values(await states()).map((found) => found.state)).toEqual(['connected', 'connected']), { timeout, interval: 2000 });
    } catch (error) {
      const events = (await stack.compose(['logs', '--no-log-prefix', 'api'])).stdout.split('\n').filter((line) => line.includes('source.'));
      const text = `states: ${JSON.stringify(await states())}\napi source events:\n${events.join('\n')}\n`;
      process.stdout.write(maskSecrets(text, [initial, rotated, wrong]));
      throw error;
    }
  }

  async function revokeOldLogin(): Promise<void> {
    for (const graph of GRAPHS) {
      const changed = await cypherShell(graph, initial, 'system', `ALTER CURRENT USER SET PASSWORD FROM '${initial}' TO '${rotated}'`);
      expect(changed.code, changed.stderr).toBe(0);
    }
    expect((await stack.compose(['restart', ...GRAPHS])).code).toBe(0);
    for (const graph of GRAPHS) {
      await vi.waitFor(async () => expect((await cypherShell(graph, rotated, 'neo4j', 'RETURN 1')).code).toBe(0), { timeout: 180_000, interval: 3000 });
    }
  }

  async function assertCutOff(): Promise<void> {
    for (const source of SOURCES) {
      const result = await testSource(source);
      expect(result.code, result.stdout + result.stderr).toBe(1);
      expect(result.stdout).toContain(REFUSED);
      for (const password of [initial, rotated, wrong]) expect(result.stdout + result.stderr).not.toContain(password);
    }
    await vi.waitFor(
      async () => {
        const found = await states();
        for (const source of SOURCES) expect(found[source], source).toEqual({ state: expect.not.stringMatching(/^connected$/), reason: REFUSED });
      },
      { timeout: 120_000, interval: 3000 },
    );
    const ready = await fetch(`${stack.url}/readyz`);
    bodies.push(await ready.text());
    expect(ready.status).toBe(200);
  }

  async function assertPingLinesLogged(): Promise<void> {
    const events = (await stack.compose(['logs', '--no-log-prefix', 'api'])).stdout.split('\n').filter((line) => line.includes('"source.ping_outcome"'));
    for (const source of SOURCES) expect(events.some((line) => line.includes(`"sourceId":"${source}"`)), `a ping outcome line of ${source}`).toBe(true);
  }

  async function assertNoPasswordAnywhere(): Promise<void> {
    const logs = (await stack.compose(['logs', '--no-log-prefix'])).stdout;
    for (const password of [initial, rotated, wrong]) {
      expect(logs).not.toContain(password);
      for (const body of bodies) expect(body).not.toContain(password);
    }
  }

  beforeAll(async () => {
    stack = await Stack.create({
      image: IMAGE,
      tag: TAG,
      file: demoComposeFile,
      overrides: [fileURLToPath(new URL('./fixtures/rotation-graph-login.yaml', import.meta.url))],
      waitSeconds: DEMO_WAIT_SECONDS,
      settings: { DEMO_NEO4J_PASSWORD: initial, GRAPH_INITIAL_PASSWORD: initial, NEBURYX_CURSOR_KEY: randomBytes(32).toString('base64'), NEBURYX_DEMO_LOADER_IMAGE: LOADER_IMAGE },
    });
    stacks.push(stack);
    const result = await stack.up();
    expect(result.code, result.stderr).toBe(0);
  }, 1_800_000);

  it('rotates in steps: the old login refused with the setting left alone, the new one working after the settings change and a recreate of the api only, and a wrong password refused again', { timeout: STACK_TEST_TIMEOUT_MS }, async () => {
    await vi.waitFor(async () => expect(Object.values(await states()).map((found) => found.state)).toEqual(['connected', 'connected']), { timeout: 60_000, interval: 2000 });
    for (const source of SOURCES) expect((await testSource(source)).code).toBe(0);

    await revokeOldLogin();
    const revokedAt = Date.now();
    await assertCutOff();
    process.stdout.write(`rotation: both sources showed the refused sign-in ${((Date.now() - revokedAt) / 1000).toFixed(1)} s after the old login was revoked and its servers answered\n`);

    await assertNoPasswordAnywhere();
    stack.updateSettings({ DEMO_NEO4J_PASSWORD: wrong });
    expect((await stack.compose(['up', '-d', '--no-deps', '--wait', 'api'])).code).toBe(0);
    await assertCutOff();

    await assertNoPasswordAnywhere();
    const idsBefore = await containerIds();
    const countsBefore = await nodeCounts();
    expect(countsBefore.every((count) => count > 0)).toBe(true);
    // The steps an operator follows, in order:
    // 1. change the login's password on the graph server;  2. put the new password in the settings file;
    // 3. recreate only the api service (`docker compose up -d --no-deps api`);  4. run `test-source` for each source.
    stack.updateSettings({ DEMO_NEO4J_PASSWORD: rotated });
    expect((await stack.compose(['up', '-d', '--no-deps', '--wait', 'api'])).code).toBe(0);
    // docs/source-state.md: after a restart whose start-up check could not reach the source, the last stored state is shown again once a ping reaches it.
    // The window holds two ping intervals (30 s each) and the few seconds the server locks a login after failed sign-ins.
    await expectBothConnected(90_000);
    // Step 4 of the guide. The server locks a login for a few seconds after failed sign-ins, so a refused run is tried again until the lock has passed.
    for (const source of SOURCES) {
      await vi.waitFor(
        async () => {
          const result = await testSource(source);
          for (const password of [initial, rotated, wrong]) expect(result.stdout + result.stderr).not.toContain(password);
          expect(result.code, result.stdout + result.stderr).toBe(0);
        },
        { timeout: 60_000, interval: 3000 },
      );
    }
    // The state must hold through a further ping of the api itself, which reaches the source with the new login, not only through the check of the separate test-source process.
    await new Promise((resolve) => setTimeout(resolve, 35_000));
    await expectBothConnected(20_000);
    expect(await containerIds()).toEqual(idsBefore);
    expect(await nodeCounts()).toEqual(countsBefore);
    await assertPingLinesLogged();
    await assertNoPasswordAnywhere();
  });
});

describe('the end of the suite', () => {
  it('leaves no container, network or volume of any stack it started', async () => {
    const projects = stacks.map((stack) => stack.project);
    expect(projects.length).toBeGreaterThan(0);
    await destroyAll(stacks);
    for (const project of projects) {
      const label = `label=com.docker.compose.project=${project}`;
      expect(await dockerOk(['ps', '-aq', '--filter', label]), project).toBe('');
      expect(await dockerOk(['network', 'ls', '-q', '--filter', label]), project).toBe('');
      expect(await dockerOk(['volume', 'ls', '-q', '--filter', label]), project).toBe('');
    }
  });
});
