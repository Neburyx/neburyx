import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourcesResponseSchema } from '@neburyx/contracts';
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';
import { docker, dockerOk, dockerStream } from '../image/docker.js';
import { DEMO_WAIT_SECONDS, demoComposeFile, destroyAll, repository, serviceOf, Stack, type EventRecorder } from './stack.js';

const IMAGE = 'neburyx-demo-test';
const TAG = `d-${randomBytes(3).toString('hex')}`;
const LOADER_IMAGE = `neburyx-demo-loader-test:${TAG}`;
/**
 * Time allowed to a test that starts a demo stack. Measured: one full start (databases, migration, both graph loads,
 * api healthy) takes 38 s on this machine with every container pinned to 2 CPUs. On the CI runner it is inferred, not
 * measured directly: run 41593551817 took 1,508 s for this file, three tests that each started their own stack timed
 * out at 300 s, and the two starts that finished account for the rest, about 220 s each. A test that starts the stack
 * may wait for it for the whole of `DEMO_WAIT_SECONDS` (600 s) and then run its own steps, so it gets 900 s.
 */
const STACK_TEST_TIMEOUT_MS = 900_000;
/**
 * `up -d api` returns as soon as `config` fails; the migrate step it started keeps running (Compose v2.38.2 waited for it, v5.1.3 and v5.6.0 do not),
 * so a test that reads its events straight after `up` depends on how long the step takes. The test slows it by this many seconds and waits for it, up to STEP_FINISH_MS (it takes a few seconds unslowed).
 */
const SLOWED_MIGRATE_SECONDS = 8;
const STEP_FINISH_MS = 60_000;
const stacks: Stack[] = [];
const folders: string[] = [];

beforeAll(async () => {
  await dockerStream(['build', '-f', 'deploy/docker/Dockerfile', '-t', `${IMAGE}:${TAG}`, '.'], repository);
  await dockerStream(['build', '-f', 'deploy/demo/loader.Dockerfile', '-t', LOADER_IMAGE, '.'], repository);
});

afterAll(async () => {
  try {
    await destroyAll(stacks);
  } finally {
    for (const folder of folders) rmSync(folder, { recursive: true, force: true });
    await docker(['rmi', '-f', `${IMAGE}:${TAG}`]);
    await docker(['rmi', '-f', LOADER_IMAGE]);
  }
});

function settings(): Record<string, string> {
  return { DEMO_NEO4J_PASSWORD: randomBytes(12).toString('hex'), NEBURYX_CURSOR_KEY: randomBytes(32).toString('base64'), NEBURYX_DEMO_LOADER_IMAGE: LOADER_IMAGE };
}

async function demoStack(extra: { readonly omit?: readonly string[]; readonly overrides?: readonly string[]; readonly settings?: Record<string, string> } = {}): Promise<Stack> {
  const stack = await Stack.create({ image: IMAGE, tag: TAG, file: demoComposeFile, waitSeconds: DEMO_WAIT_SECONDS, settings: extra.settings ?? settings(), ...(extra.omit === undefined ? {} : { omit: extra.omit }), ...(extra.overrides === undefined ? {} : { overrides: extra.overrides }) });
  stacks.push(stack);
  return stack;
}

function quoteIdentifier(name: string): string {
  return `\`${name.replaceAll('`', '``')}\``;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

function cypherShell(stack: Stack, graph: string, statement: string) {
  return stack.compose(['exec', '-T', graph, 'sh', '-c', 'cypher-shell -u neo4j -p "$DEMO_NEO4J_PASSWORD" --format plain "$1"', 'sh', statement]);
}

async function release(stack: Stack, recorder?: EventRecorder): Promise<void> {
  await recorder?.stop();
  await stack.destroy();
  const position = stacks.indexOf(stack);
  if (position >= 0) stacks.splice(position, 1);
}

const API_WITHOUT_GRAPHS = `services:
  api:
    depends_on: !override
      db:
        condition: service_healthy
      migrate:
        condition: service_completed_successfully
      config:
        condition: service_completed_successfully
`;

function overrideFile(text: string): string {
  const folder = mkdtempSync(join(tmpdir(), 'demo-override-'));
  folders.push(folder);
  const file = join(folder, 'override.yaml');
  writeFileSync(file, text);
  return file;
}

async function startsOf(recorder: EventRecorder, sinceNano: number, service: string): Promise<number> {
  await recorder.sync();
  return recorder.since(sinceNano).filter((event) => serviceOf(event) === service && event.Action === 'start').length;
}

const bindings = z.record(z.string(), z.array(z.object({ HostIp: z.string(), HostPort: z.string() })).nullable());
const composeModel = z.object({
  services: z.record(z.string(), z.object({ ports: z.array(z.object({ host_ip: z.string().optional(), published: z.union([z.string(), z.number()]).optional() })).optional(), volumes: z.array(z.object({ type: z.string(), source: z.string().optional() })).optional() })),
  volumes: z.record(z.string(), z.unknown()),
});

const packMappingSchema = z.object({
  sources: z.tuple([
    z.object({
      id: z.string(),
      entities: z.array(z.object({ type: z.string(), label: z.string(), stable_id: z.string() })),
      relationships: z.array(z.object({ type: z.string(), from: z.string(), to: z.string() })),
    }),
  ]),
});

const presetSchema = z.object({ entity: z.object({ type: z.string(), id: z.string() }), case_ref: z.string() });

function presetOf(name: string): z.infer<typeof presetSchema> {
  return z.object({ preset: presetSchema }).parse(parse(readFileSync(join(repository, 'domain-packs', name, 'cases.yaml'), 'utf8'))).preset;
}

/** The source entry of a pack as the combined mapping holds it: the pack's own entry and the preset of its cases file as the demo case. */
function packSource(name: string): unknown {
  const whole: unknown = parse(readFileSync(join(repository, 'domain-packs', name, 'neburyx.yaml'), 'utf8'));
  const [source] = z.object({ sources: z.array(z.record(z.string(), z.unknown())).length(1) }).parse(whole).sources;
  return { ...source, demo_case: presetOf(name) };
}

function packOf(name: string) {
  const [source] = packMappingSchema.parse(parse(readFileSync(join(repository, 'domain-packs', name, 'neburyx.yaml'), 'utf8'))).sources;
  return source;
}

const DEMO_PACKS = ['banking-fraud', 'insurance-claims'] as const;
const GRAPH_OF: Record<(typeof DEMO_PACKS)[number], string> = { 'banking-fraud': 'demo-banking-graph', 'insurance-claims': 'demo-insurance-graph' };


describe('the demo stack', () => {
  let stack: Stack;
  let recorder: EventRecorder;
  let startedAt: number;

  beforeAll(async () => {
    stack = await demoStack();
    recorder = await stack.record();
    startedAt = Date.now() * 1e6;
    const result = await stack.up();
    expect(result.code, result.stderr).toBe(0);
  });

  afterAll(async () => {
    await release(stack, recorder);
  });

  async function sourcesAreConnected(): Promise<void> {
    await vi.waitFor(
      async () => {
        const body = sourcesResponseSchema.parse(await (await fetch(`${stack.url}/v1/sources`)).json());
        const demoCaseOf = (name: (typeof DEMO_PACKS)[number]) => {
          const { entity, case_ref: caseRef } = presetOf(name);
          return { entityType: entity.type, stableId: entity.id, caseRef };
        };
        expect(body.items.map((item) => [item.id, item.state, item.synthetic, item.demoCase]).sort()).toEqual([
          ['banking-demo', 'connected', true, demoCaseOf('banking-fraud')],
          ['insurance-demo', 'connected', true, demoCaseOf('insurance-claims')],
        ]);
      },
      { timeout: 60_000, interval: 2000 },
    );
  }

  it('shows both demo sources as connected and synthetic', sourcesAreConnected);

  it('finishes the config container and both loaders with exit code 0 before the api container starts', async () => {
    await recorder.sync();
    const events = recorder.since(startedAt);
    const serving = events.find((event) => serviceOf(event) === 'api' && event.Action === 'start');
    expect(serving).toBeDefined();
    for (const service of ['config', 'load-banking', 'load-insurance']) {
      const finished = events.find((event) => serviceOf(event) === service && event.Action === 'die');
      expect(finished?.Actor.Attributes['exitCode'], service).toBe('0');
      expect(finished?.timeNano, service).toBeLessThan(serving?.timeNano ?? 0);
    }
  });

  it('publishes the api port on 127.0.0.1 and nothing else', async () => {
    for (const service of ['db', 'migrate', 'demo-banking-graph', 'demo-insurance-graph', 'load-banking', 'load-insurance', 'config']) {
      const raw = await dockerOk(['inspect', '--format', '{{json .HostConfig.PortBindings}}', await stack.containerId(service)]);
      expect(Object.values(bindings.parse(JSON.parse(raw))).flatMap((list) => list ?? []), service).toEqual([]);
    }
    const raw = await dockerOk(['inspect', '--format', '{{json .HostConfig.PortBindings}}', await stack.containerId('api')]);
    expect(Object.values(bindings.parse(JSON.parse(raw))).flatMap((list) => list ?? [])).toEqual([{ HostIp: '127.0.0.1', HostPort: String(stack.port) }]);
  });

  it('reads the database initialisation folder of the Community file and declares the volumes it uses', async () => {
    const model = composeModel.parse(JSON.parse((await stack.compose(['config', '--format', 'json'])).stdout));
    const sources = model.services['db']?.volumes?.map((volume) => volume.source) ?? [];
    expect(sources.some((source) => source?.endsWith('/deploy/compose/initdb'))).toBe(true);
    expect(Object.keys(model.volumes).sort()).toEqual(['demo-config', 'neburyx-db', 'neburyx-exports']);
    for (const [name, service] of Object.entries(model.services)) {
      const published = (service.ports ?? []).map((port) => port.host_ip);
      expect(published, name).toEqual(name === 'api' ? ['127.0.0.1'] : []);
    }
  });

  it('serves the api from the mapping file the config container wrote, equal to the packs, mounted read-only, and no mapping file is committed in the demo folder', async () => {
    const apiId = await stack.containerId('api');
    const environment = z.array(z.string()).parse(JSON.parse(await dockerOk(['inspect', '--format', '{{json .Config.Env}}', apiId])));
    expect(environment).toContain('NEBURYX_CONFIG=/config/neburyx.yaml');
    const mounts = z.array(z.object({ Destination: z.string(), RW: z.boolean() })).parse(JSON.parse(await dockerOk(['inspect', '--format', '{{json .Mounts}}', apiId])));
    expect(mounts.find((mount) => mount.Destination === '/config')?.RW).toBe(false);
    const written = (await stack.compose(['exec', '-T', 'api', 'cat', '/config/neburyx.yaml'])).stdout;
    expect(parse(written)).toEqual({ sources: DEMO_PACKS.map((name) => packSource(name)) });
    expect(readdirSync(join(repository, 'deploy/demo')).filter((name) => name.endsWith('.yaml') && !['compose.yaml', 'compose.dev.yaml'].includes(name))).toEqual([]);
  });

  function testSource(name: string) {
    return stack.compose(['run', '-T', '--no-deps', '--rm', 'api', 'test-source', '--name', name]);
  }

  async function loaderStartsSince(since: number): Promise<number> {
    await recorder.sync();
    const events = recorder.since(since);
    return events.filter((event) => ['load-banking', 'load-insurance', 'config'].includes(serviceOf(event) ?? '') && event.Action === 'start').length;
  }

  describe.each(DEMO_PACKS)('the %s pack', (name) => {
    const source = packOf(name);
    const first = source.entities[0];

    it('passes, prints the read-only line as not verified, the mapping summary and the degree lines, and starts no loader', async () => {
      const since = Date.now() * 1e6;
      const result = await testSource(source.id);
      expect(result.code, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain(`Source: ${source.id}`);
      expect(result.stdout).toContain('Read-only: not verified');
      expect(result.stdout).toContain(`Mapping: ${source.entities.length} entity types, ${source.relationships.length} relationship types`);
      const withRelationships = new Set(source.relationships.flatMap((relationship) => [relationship.from, relationship.to]));
      for (const entity of source.entities.filter((candidate) => withRelationships.has(candidate.type))) {
        expect(result.stdout).toMatch(new RegExp(`^  ${entity.type}: (cheap|not cheap|could not tell) \\(`, 'm'));
      }
      expect(await loaderStartsSince(since)).toBe(0);
    });

    it('fails and names the entity type and its stable ID property when the stable ID constraint is dropped, and passes again when it is recreated', async () => {
      if (first === undefined) throw new Error('the pack has no entity type');
      const graph = GRAPH_OF[name];
      const label = quoteIdentifier(first.label);
      const property = quoteIdentifier(first.stable_id);
      const found = await cypherShell(stack, graph, `SHOW CONSTRAINTS YIELD name, labelsOrTypes, properties WHERE labelsOrTypes = [${quoteLiteral(first.label)}] AND properties = [${quoteLiteral(first.stable_id)}] RETURN name`);
      const constraint = /"([^"]+)"/.exec(found.stdout)?.[1];
      expect(constraint, found.stdout + found.stderr).toBeDefined();
      try {
        expect((await cypherShell(stack, graph, `DROP CONSTRAINT ${quoteIdentifier(constraint ?? '')}`)).code).toBe(0);
        const broken = await testSource(source.id);
        expect(broken.code, broken.stdout).toBe(1);
        expect(broken.stdout).toContain(first.type);
        expect(broken.stdout).toContain(first.stable_id);
      } finally {
        expect((await cypherShell(stack, graph, `CREATE CONSTRAINT IF NOT EXISTS FOR (n:${label}) REQUIRE n.${property} IS UNIQUE`)).code).toBe(0);
      }
      const restored = await testSource(source.id);
      expect(restored.code, restored.stdout).toBe(0);
    });
  });

  it('exits 2 for a source name that is not configured, starts no loader and leaves the graphs as they were', async () => {
    const counts = async (): Promise<number[]> =>
      Promise.all(
        Object.values(GRAPH_OF).map(async (graph) => {
          const result = await cypherShell(stack, graph, 'MATCH (n) RETURN count(n)');
          expect(result.code, result.stderr).toBe(0);
          const count = Number(result.stdout.trim().split('\n').at(-1));
          expect(Number.isInteger(count) && count > 0, result.stdout).toBe(true);
          return count;
        }),
      );
    const before = await counts();
    const since = Date.now() * 1e6;
    const result = await testSource('no-such-source');
    expect(result.code).toBe(2);
    expect(await loaderStartsSince(since)).toBe(0);
    expect(await counts()).toEqual(before);
  });

  it('loads both graphs again and shows both sources connected when it is stopped and started again', { timeout: STACK_TEST_TIMEOUT_MS }, async () => {
    const nodeCounts = async (): Promise<number[]> =>
      Promise.all(
        Object.values(GRAPH_OF).map(async (graph) => {
          const result = await cypherShell(stack, graph, 'MATCH (n) RETURN count(n)');
          expect(result.code, result.stderr).toBe(0);
          return Number(result.stdout.trim().split('\n').at(-1));
        }),
      );
    for (const pack of DEMO_PACKS) {
      const before = await testSource(packOf(pack).id);
      expect(before.code, `${pack} must pass test-source before the restart: ${before.stdout}`).toBe(0);
    }
    const countsBefore = await nodeCounts();
    expect(countsBefore.every((count) => Number.isInteger(count) && count > 0), String(countsBefore)).toBe(true);
    expect((await stack.compose(['stop'])).code).toBe(0);
    const since = Date.now() * 1e6;
    const again = await stack.up();
    expect(again.code, again.stderr).toBe(0);
    await recorder.sync();
    const events = recorder.since(since);
    for (const service of ['load-banking', 'load-insurance']) {
      expect(events.find((event) => serviceOf(event) === service && event.Action === 'die')?.Actor.Attributes['exitCode'], service).toBe('0');
    }
    await sourcesAreConnected();
    expect(await nodeCounts()).toEqual(countsBefore);
    for (const pack of DEMO_PACKS) {
      const after = await testSource(packOf(pack).id);
      expect(after.code, `${pack} must pass test-source after the restart: ${after.stdout}`).toBe(0);
    }
  });
});

describe('the development override', () => {
  const override = join(repository, 'deploy/demo/compose.dev.yaml');

  it('publishes the database and each graph on one port bound to 127.0.0.1, nothing else, and starts no api, migrate or config container', { timeout: STACK_TEST_TIMEOUT_MS }, async () => {
    const stack = await demoStack({ overrides: [override] });
    onTestFinished(() => release(stack));
    const started = await stack.compose(['up', '-d', '--wait', '--wait-timeout', String(DEMO_WAIT_SECONDS), 'db', 'demo-banking-graph', 'demo-insurance-graph']);
    expect(started.code, started.stderr).toBe(0);
    const model = composeModel.parse(JSON.parse((await stack.compose(['config', '--format', 'json'])).stdout));
    for (const [name, service] of Object.entries(model.services)) {
      const expected = ['db', 'demo-banking-graph', 'demo-insurance-graph'].includes(name) ? ['127.0.0.1'] : name === 'api' ? ['127.0.0.1'] : [];
      expect((service.ports ?? []).map((port) => port.host_ip), name).toEqual(expected);
    }
    for (const [service, containerPort] of [['db', 5432], ['demo-banking-graph', 7687], ['demo-insurance-graph', 7687]] as const) {
      const raw = await dockerOk(['inspect', '--format', '{{json .HostConfig.PortBindings}}', await stack.containerId(service)]);
      const published = Object.values(bindings.parse(JSON.parse(raw))).flatMap((list) => list ?? []);
      expect(published, service).toHaveLength(1);
      expect(published[0]?.HostIp, service).toBe('127.0.0.1');
      const found = await stack.compose(['port', service, String(containerPort)]);
      expect(found.stdout.trim(), service).toMatch(/^127\.0\.0\.1:\d+$/);
    }
    for (const service of ['api', 'migrate', 'config', 'load-banking', 'load-insurance']) expect(await stack.containerId(service), service).toBe('');
  });
});

describe('a demo stack with a step that fails', () => {
  it('starts no api container when the config step fails over an older mapping in the volume', { timeout: STACK_TEST_TIMEOUT_MS }, async () => {
    const override = overrideFile(API_WITHOUT_GRAPHS);
    const stack = await demoStack({ overrides: [override] });
    const recorder = await stack.record();
    onTestFinished(() => release(stack, recorder));
    const readMapping = () => stack.compose(['run', '-T', '--rm', '--no-deps', '--entrypoint', 'cat', 'config', '/config/neburyx.yaml']);
    const seeded = await stack.compose(['run', '-T', '--rm', '--no-deps', 'config']);
    expect(seeded.code, seeded.stderr).toBe(0);
    const older = await readMapping();
    expect(parse(older.stdout)).toEqual({ sources: DEMO_PACKS.map((name) => packSource(name)) });

    writeFileSync(override, `${API_WITHOUT_GRAPHS}  config:\n    command: ["combine", "--packs", "no-such-pack", "--out", "/config/neburyx.yaml"]\n  migrate:\n    entrypoint: ["sh", "-c", "sleep ${SLOWED_MIGRATE_SECONDS}; exec node dist/cli.js \\"$$@\\"", "sh"]\n`);
    const since = Date.now() * 1e6;
    const broken = await stack.compose(['up', '-d', 'api']);
    expect(broken.code).not.toBe(0);
    await recorder.finished(since, 'migrate', STEP_FINISH_MS);
    await recorder.sync();
    const events = recorder.since(since);
    expect(events.find((event) => serviceOf(event) === 'config' && event.Action === 'die')?.Actor.Attributes['exitCode']).toBe('2');
    expect(events.filter((event) => serviceOf(event) === 'migrate' && event.Action === 'die' && event.Actor.Attributes['exitCode'] !== '0')).toEqual([]);
    expect((await stack.compose(['logs', '--no-log-prefix', 'config'])).stdout).toContain('there is no such pack');
    expect(await startsOf(recorder, since, 'api')).toBe(0);
    expect((await readMapping()).stdout).toBe(older.stdout);
  });

  it('starts no api container when the banking loader is refused by its graph', { timeout: STACK_TEST_TIMEOUT_MS }, async () => {
    const override = overrideFile(
      'services:\n  load-banking:\n    environment:\n      DEMO_NEO4J_PASSWORD: not-the-password-of-the-graph\n  load-insurance:\n    command: ["generate", "--pack", "insurance-claims", "--out", "/tmp/unused"]\n',
    );
    const values = settings();
    const stack = await demoStack({ overrides: [override], settings: values });
    const recorder = await stack.record();
    onTestFinished(() => release(stack, recorder));
    const since = Date.now() * 1e6;
    const refused = await stack.up();
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain('load-banking-1: exited, exit code 1');
    expect(refused.stderr).toContain('demo-banking-graph-1: running, exit code 0, health healthy');
    expect(refused.stderr).not.toContain(values['DEMO_NEO4J_PASSWORD']);
    expect(refused.stderr).not.toContain(values['NEBURYX_CURSOR_KEY']);
    expect(refused.stderr).not.toContain(stack.passwords.NEBURYX_DB_APP_PASSWORD);
    await recorder.finished(since, 'load-insurance', STEP_FINISH_MS);
    await recorder.sync();
    const events = recorder.since(since);
    expect(events.find((event) => serviceOf(event) === 'load-banking' && event.Action === 'die')?.Actor.Attributes['exitCode']).toBe('1');
    expect(events.find((event) => serviceOf(event) === 'load-insurance' && event.Action === 'die')?.Actor.Attributes['exitCode']).toBe('0');
    expect(await dockerOk(['inspect', '--format', '{{.State.Health.Status}}', await stack.containerId('demo-banking-graph')])).toBe('healthy');
    expect((await stack.compose(['logs', '--no-log-prefix', 'load-banking'])).stdout).toContain('Unauthorized');
    expect(await startsOf(recorder, since, 'api')).toBe(0);
  });
});

describe('a demo stack next to a source.env of the Community install', () => {
  it('does not hand that file to its api, and still mounts its own mapping', async () => {
    const file = join(repository, 'deploy/compose/source.env');
    writeFileSync(file, 'COMPOSE_TEST_USER=from-the-community-install\n', { mode: 0o600 });
    try {
      const stack = await demoStack();
      onTestFinished(() => release(stack));
      const resolved = await stack.compose(['config', '--format', 'json']);
      expect(resolved.code, resolved.stderr).toBe(0);
      const api = z.object({ services: z.object({ api: z.object({ environment: z.record(z.string(), z.string()), volumes: z.array(z.object({ target: z.string() })) }) }) }).parse(JSON.parse(resolved.stdout)).services.api;
      expect(api.environment).not.toHaveProperty('COMPOSE_TEST_USER');
      expect(api.environment['NEBURYX_CONFIG']).toBe('/config/neburyx.yaml');
      expect(api.volumes.map((volume) => volume.target).sort()).toEqual(['/config', '/data/exports']);
    } finally {
      rmSync(file, { force: true });
    }
  });
});

describe('a demo stack with a Neo4j password or a cursor key that breaks its rule', () => {
  it.each([
    ['a Neo4j password of 7 characters', 'DEMO_NEO4J_PASSWORD', 'abc1234', 'DEMO_NEO4J_PASSWORD-at-least-8-characters'],
    ['a cursor key of 7 characters', 'NEBURYX_CURSOR_KEY', 'abc1234', 'NEBURYX_CURSOR_KEY-base64-of-at-least-32-bytes'],
  ])('stops docker compose up naming the setting and the rule, before any database or app starts, for %s', async (_label, variable, value, service) => {
    const stack = await demoStack({ settings: { ...settings(), [variable]: value } });
    onTestFinished(() => release(stack));
    const result = await stack.compose(['up', '--wait', '--wait-timeout', '120']);
    const output = `${result.stdout}${result.stderr}`;
    expect(result.code).not.toBe(0);
    expect(output).toContain(`service "${service}" didn't complete successfully`);
    expect(output).not.toContain(value);
    const started = await stack.everStarted();
    for (const name of ['db', 'migrate', 'api', 'demo-banking-graph', 'demo-insurance-graph', 'load-banking', 'load-insurance']) expect(started, name).not.toContain(name);
    const logs = (await stack.compose(['logs', '--no-log-prefix', service])).stdout;
    expect(logs).toContain(`${variable} must be`);
    expect(logs).not.toContain(value);
  });
});

describe('a demo stack with a setting that is missing or wrong', () => {
  const REQUIRED = ['NEBURYX_DB_ADMIN_PASSWORD', 'NEBURYX_DB_MIGRATION_PASSWORD', 'NEBURYX_DB_APP_PASSWORD', 'DEMO_NEO4J_PASSWORD', 'NEBURYX_CURSOR_KEY'];

  it.each(REQUIRED.flatMap((name) => [[name, 'missing'] as const, [name, 'empty'] as const]))('stops docker compose up before any container exists, naming %s when it is %s', async (name, how) => {
    const stack = await demoStack({ ...(how === 'missing' ? { omit: [name] } : { settings: { ...settings(), [name]: '' } }) });
    onTestFinished(() => release(stack));
    const result = await stack.compose(['up', '--no-start']);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(name);
    expect(await dockerOk(['ps', '-aq', '--filter', `label=com.docker.compose.project=${stack.project}`])).toBe('');
  });

  it('stops the api with exit code 1 and a message that names the variable and does not repeat its value, for a cursor key that is not a key', { timeout: STACK_TEST_TIMEOUT_MS }, async () => {
    const bad = `${'A'.repeat(42)}B`;
    const stack = await demoStack({ settings: { ...settings(), NEBURYX_CURSOR_KEY: bad }, overrides: [overrideFile(API_WITHOUT_GRAPHS)] });
    const recorder = await stack.record();
    onTestFinished(() => release(stack, recorder));
    const since = Date.now() * 1e6;
    const result = await stack.compose(['up', '-d', 'api']);
    expect(result.code, result.stderr).toBe(0);
    await vi.waitFor(
      async () => {
        const died = recorder.since(since).find((event) => serviceOf(event) === 'api' && event.Action === 'die');
        expect(died?.Actor.Attributes['exitCode']).toBe('1');
      },
      { timeout: 120_000, interval: 3000 },
    );
    const logs = (await stack.compose(['logs', '--no-log-prefix', 'api'])).stdout;
    expect(logs).toContain('invalid configuration');
    expect(logs).toContain('NEBURYX_CURSOR_KEY');
    expect(logs).not.toContain(bad);
  });
});
