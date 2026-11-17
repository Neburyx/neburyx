import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourcesResponseSchema } from '@neburyx/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { docker, dockerOk, dockerStream } from '../image/docker.js';
import { planImages } from './image-plan.js';
import { DEMO_WAIT_SECONDS, destroyAll, maskSecrets, repository, Stack } from './stack.js';

const images = planImages(process.env, { image: 'neburyx-install-guide-test', tag: `g-${randomBytes(3).toString('hex')}` });
const IMAGE = images.image;
const TAG = images.tag;
const STACK_TEST_TIMEOUT_MS = 900_000;
const SOURCES_POLL_TIMEOUT_MS = 60_000;
const SOURCES_POLL_INTERVAL_MS = 2_000;
const REQUEST_TIMEOUT_MS = 5_000;
const INDEX_WAIT_SECONDS = 60;
const SOURCE_ID = 'my-graph';
const stacks: Stack[] = [];
const folders: string[] = [];

beforeAll(async () => {
  if (images.built) await dockerStream(['build', '-f', 'deploy/docker/Dockerfile', '-t', `${IMAGE}:${TAG}`, '.'], repository);
});

afterAll(async () => {
  try {
    await destroyAll(stacks);
  } finally {
    for (const folder of folders) rmSync(folder, { recursive: true, force: true });
    if (images.built) await docker(['rmi', '-f', `${IMAGE}:${TAG}`]);
  }
});

const MAPPING = `sources:
  - id: ${SOURCE_ID}
    uri: "bolt://graph:7687"
    database: neo4j
    auth: { kind: basic, username_env: MY_GRAPH_USER, password_env: MY_GRAPH_PASSWORD }
    entities:
      - type: account
        label: Account
        stable_id: accountId
`;

/** The Community file has no graph server of its own, so the test adds one; `source.env` is named by path because the test must not write next to the compose file in the repository. */
function overrideText(sourceEnv: string, graphPassword: string): string {
  return `services:
  graph:
    image: \${NEBURYX_DEMO_NEO4J_IMAGE:-neo4j:5.26}
    environment:
      NEO4J_AUTH: neo4j/${graphPassword}
      NEO4J_server_memory_heap_initial__size: 512m
      NEO4J_server_memory_heap_max__size: 512m
      NEO4J_server_memory_pagecache_size: 128m
    healthcheck:
      test: ["CMD-SHELL", "cypher-shell -u neo4j -p ${graphPassword} 'RETURN 1' || exit 1"]
      start_period: 60s
      interval: 3s
      timeout: 10s
      retries: 60
  api:
    depends_on:
      graph:
        condition: service_healthy
    env_file: !override
      - path: ${sourceEnv}
        required: true
`;
}

function writeSourceEnv(file: string, password: string): void {
  writeFileSync(file, `MY_GRAPH_USER=neo4j\nMY_GRAPH_PASSWORD=${password}\n`);
  chmodSync(file, 0o600);
}

function settings(): Record<string, string> {
  return { NEBURYX_CURSOR_KEY: randomBytes(32).toString('base64') };
}

describe('connecting a source and checking it, as docs/install.md words them', () => {
  const graphPassword = randomBytes(12).toString('hex');
  const wrongPassword = randomBytes(12).toString('hex');
  const secrets = [graphPassword, wrongPassword];
  let stack: Stack;
  let sourceEnv: string;

  function shown(result: { readonly stdout: string; readonly stderr: string }): string {
    return maskSecrets(`${result.stdout}\n${result.stderr}`, secrets);
  }

  function leaksSecret(result: { readonly stdout: string; readonly stderr: string }): boolean {
    return secrets.some((secret) => `${result.stdout}\n${result.stderr}`.includes(secret));
  }

  function testSource() {
    return stack.compose(['run', '-T', '--rm', '--no-deps', 'api', 'test-source', '--name', SOURCE_ID]);
  }

  beforeAll(async () => {
    const folder = mkdtempSync(join(tmpdir(), 'install-guide-'));
    folders.push(folder);
    sourceEnv = join(folder, 'source.env');
    writeSourceEnv(sourceEnv, graphPassword);
    const override = join(folder, 'graph.override.yaml');
    writeFileSync(override, overrideText(sourceEnv, graphPassword));
    stack = await Stack.create({ image: IMAGE, tag: TAG, overrides: [override], mapping: { text: MAPPING }, settings: settings(), waitSeconds: DEMO_WAIT_SECONDS });
    stacks.push(stack);

    const graph = await stack.compose(['up', '--wait', '--wait-timeout', String(DEMO_WAIT_SECONDS), 'graph']);
    expect(graph.code, shown(graph)).toBe(0);
    const seed = await stack.compose([
      'exec', '-T', 'graph', 'cypher-shell', '-u', 'neo4j', '-p', graphPassword,
      `CREATE CONSTRAINT account_id FOR (a:Account) REQUIRE a.accountId IS UNIQUE; CREATE (:Account {accountId: 'a-1'}); CALL db.awaitIndexes(${INDEX_WAIT_SECONDS});`,
    ]);
    expect(seed.code, shown(seed)).toBe(0);
    const up = await stack.up();
    expect(up.code, shown(up)).toBe(0);
  }, STACK_TEST_TIMEOUT_MS);

  it('lists the source as connected on GET /v1/sources', async () => {
    await vi.waitFor(
      async () => {
        const response = await fetch(`${stack.url}/v1/sources`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        const body = sourcesResponseSchema.parse(await response.json());
        expect(body.items.map((item) => [item.id, item.state])).toEqual([[SOURCE_ID, 'connected']]);
      },
      { timeout: SOURCES_POLL_TIMEOUT_MS, interval: SOURCES_POLL_INTERVAL_MS },
    );
  }, STACK_TEST_TIMEOUT_MS);

  it('passes test-source as the guide gives it, and reports the read-only result a Neo4j Community login cannot verify', async () => {
    writeSourceEnv(sourceEnv, graphPassword);
    const result = await testSource();
    expect(result.code, shown(result)).toBe(0);
    expect(shown(result)).toContain('Read-only: not verified');
    expect(leaksSecret(result), 'the output of test-source holds a source password').toBe(false);
  }, STACK_TEST_TIMEOUT_MS);

  it('exits 1 and gives the refused sign-in as the reason when the password in source.env is wrong', async () => {
    writeSourceEnv(sourceEnv, wrongPassword);
    try {
      const result = await testSource();
      expect(result.code, shown(result)).toBe(1);
      expect(shown(result)).toMatch(/^Reason: The source refused the sign-in\./m);
      expect(leaksSecret(result), 'the output of test-source holds a source password').toBe(false);
    } finally {
      writeSourceEnv(sourceEnv, graphPassword);
    }
  }, STACK_TEST_TIMEOUT_MS);
});

describe('stopping and removing, as docs/install.md words them', () => {
  const MARKER_FILE = '/data/exports/install-guide-marker.txt';
  const MARKER_TABLE = 'install_guide_marker';

  async function namedVolumes(stack: Stack): Promise<string[]> {
    return (await dockerOk(['volume', 'ls', '--format', '{{.Name}}', '--filter', `label=com.docker.compose.project=${stack.project}`])).split('\n').filter(Boolean);
  }

  async function markers(stack: Stack): Promise<{ readonly file: string; readonly row: string }> {
    const file = await stack.compose(['exec', '-T', 'api', 'cat', MARKER_FILE]);
    const row = await stack.psql(`SELECT id FROM ${MARKER_TABLE}`, 'postgres', 'neburyx');
    return { file: file.stdout.trim(), row: row.stdout.trim() };
  }

  it('removes the containers on down and keeps the database and the export files, and removes both on down -v', async () => {
    const stack = await Stack.create({ image: IMAGE, tag: TAG, settings: settings(), waitSeconds: DEMO_WAIT_SECONDS });
    stacks.push(stack);
    const up = await stack.up();
    expect(up.code, up.stderr).toBe(0);
    expect((await stack.compose(['exec', '-T', 'api', 'sh', '-c', `echo exports-kept > ${MARKER_FILE}`])).code).toBe(0);
    expect((await stack.psql(`CREATE TABLE ${MARKER_TABLE} (id integer PRIMARY KEY); INSERT INTO ${MARKER_TABLE} VALUES (7)`, 'postgres', 'neburyx')).code).toBe(0);
    const volumes = await namedVolumes(stack);
    const database = volumes.filter((name) => name.endsWith('neburyx-db'));
    const exportFiles = volumes.filter((name) => name.endsWith('neburyx-exports'));
    expect([database.length, exportFiles.length], volumes.join(',')).toEqual([1, 1]);

    const down = await stack.compose(['down']);
    expect(down.code, down.stderr).toBe(0);
    expect(await dockerOk(['ps', '-aq', '--filter', `label=com.docker.compose.project=${stack.project}`])).toBe('');
    expect(await namedVolumes(stack)).toEqual(expect.arrayContaining([...database, ...exportFiles]));

    const again = await stack.up();
    expect(again.code, again.stderr).toBe(0);
    expect(await markers(stack)).toEqual({ file: 'exports-kept', row: '7' });

    const downVolumes = await stack.compose(['down', '-v']);
    expect(downVolumes.code, downVolumes.stderr).toBe(0);
    expect(await namedVolumes(stack)).toEqual([]);
  }, STACK_TEST_TIMEOUT_MS);
});
