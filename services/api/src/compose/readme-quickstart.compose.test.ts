import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { docker } from '../image/docker.js';
import { BUDGET_DEFAULTS } from '../mapping/budgets.js';
import { RETENTION_DEFAULTS } from '../mapping/retention.js';
import { Doc } from '../testing/doc.js';
import { quickstartOf } from '../testing/quickstart.js';
import { freePort, maskSecrets, repository } from './stack.js';

const execute = promisify(execFile);
const RUN = randomBytes(3).toString('hex');
const IMAGE = `neburyx-readme-${RUN}`;
const LOADER_IMAGE = `neburyx-demo-loader-readme-${RUN}`;
const PROJECTS: string[] = [];
const FOLDERS: string[] = [];
const LISTENERS: Server[] = [];
const SECRETS: string[] = [];
const TIMES: string[] = [];

const BUILD = /^docker build -f deploy\/docker\/Dockerfile -t neburyx \.$/;
const FORM: readonly RegExp[] = [BUILD, /^cd deploy\/demo$/, /^cp \.env\.example \.env$/, /^docker compose up --wait$/, /^docker compose run --rm --no-deps api test-source --name (banking|insurance)-demo$/, /^docker compose stop$/, /^docker compose down -v$/];

interface Outcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function projectName(): string {
  const name = `nbx-readme-${randomBytes(3).toString('hex')}`;
  PROJECTS.push(name);
  return name;
}

async function listener(): Promise<{ readonly port: number; readonly server: Server }> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  LISTENERS.push(server);
  return { port: typeof address === 'object' && address !== null ? address.port : 0, server };
}

async function otherThan8080(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await freePort();
    if (port !== 8080) return port;
  }
  throw new Error('no free port other than 8080');
}

const closed = (server: Server): Promise<void> => new Promise((resolve) => (server.listening ? server.close(() => resolve()) : resolve()));

async function run(args: readonly string[], cwd: string, env: Record<string, string>): Promise<Outcome> {
  try {
    const { stdout, stderr } = await execute('docker', [...args], { cwd, env: { ...process.env, ...env }, maxBuffer: 256 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failure.code === 'number' ? failure.code : 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

function build(cwd: string, args: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', [...args], { cwd, stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

const show = (label: string, outcome: Outcome): string => maskSecrets(`${label}: exit ${outcome.code}\n${outcome.stdout.slice(-1500)}\n${outcome.stderr.slice(-1500)}`, SECRETS);

function envFile(values: Record<string, string | undefined>): string {
  return Object.entries(values).flatMap(([key, value]) => (value === undefined ? [] : [`${key}=${value}`])).join('\n') + '\n';
}

function settings(port: number, extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const secrets = {
    NEBURYX_DB_ADMIN_PASSWORD: randomBytes(24).toString('hex'),
    NEBURYX_DB_MIGRATION_PASSWORD: randomBytes(24).toString('hex'),
    NEBURYX_DB_APP_PASSWORD: randomBytes(24).toString('hex'),
    DEMO_NEO4J_PASSWORD: randomBytes(24).toString('hex'),
    NEBURYX_CURSOR_KEY: randomBytes(32).toString('base64'),
  };
  SECRETS.push(...Object.values(secrets));
  return { ...secrets, NEBURYX_IMAGE: IMAGE, NEBURYX_DEMO_LOADER_IMAGE: LOADER_IMAGE, NEBURYX_PORT: String(port), ...extra };
}

async function cleanUp(project: string, cwd: string): Promise<void> {
  await run(['compose', 'down', '-v'], cwd, { COMPOSE_PROJECT_NAME: project });
}

async function remaining(project: string): Promise<string> {
  const filter = `label=com.docker.compose.project=${project}`;
  const containers = (await docker(['ps', '-aq', '--filter', filter])).stdout.trim();
  const volumes = (await docker(['volume', 'ls', '-q', '--filter', filter])).stdout.trim();
  const networks = (await docker(['network', 'ls', '-q', '--filter', filter])).stdout.trim();
  return [containers, volumes, networks].filter((part) => part !== '').join(',');
}

afterAll(async () => {
  for (const server of LISTENERS) await closed(server);
  const left: string[] = [];
  for (const project of PROJECTS) left.push(await remaining(project));
  for (const folder of FOLDERS) rmSync(folder, { recursive: true, force: true });
  await docker(['rmi', '-f', `${IMAGE}:latest`]);
  await docker(['rmi', '-f', `${LOADER_IMAGE}:latest`]);
  expect(left.filter((entry) => entry !== '')).toEqual([]);
});

describe('the README Quickstart, run as written on a fresh clone', () => {
  it('takes the page\'s commands in order, with three named differences, and reaches the case through the API', { timeout: 2_400_000 }, async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'readme-quickstart-'));
    FOLDERS.push(scratch);
    const clone = join(scratch, 'clone');
    const reachable = await docker(['info']);
    expect(reachable.code, 'Docker is not reachable; this test does not start it').toBe(0);
    const head = (await execute('git', ['rev-parse', 'HEAD'], { cwd: repository })).stdout.trim();
    await execute('git', ['clone', '--quiet', '--no-hardlinks', repository, clone]);
    await execute('git', ['checkout', '--quiet', '--detach', head], { cwd: clone });
    expect((await execute('git', ['rev-parse', 'HEAD'], { cwd: clone })).stdout.trim()).toBe(head);
    const demo = join(clone, 'deploy/demo');
    const port = await otherThan8080();
    const project = projectName();

    const commands = quickstartOf(new Doc(join(clone, 'README.md'))).fenced();
    const unknown = commands.filter((command) => !FORM.some((form) => form.test(command)));
    expect(unknown, 'the Quickstart has a command of another form').toEqual([]);

    const stopAt = commands.indexOf('docker compose stop');
    expect(stopAt).toBeGreaterThan(0);
    const before = commands.slice(0, stopAt);
    const after = commands.slice(stopAt);

    let cwd = clone;
    const began = Date.now();
    const env = { COMPOSE_PROJECT_NAME: project };
    const timed = async (command: string, action: () => Promise<Outcome>): Promise<Outcome> => {
      const started = Date.now();
      const outcome = await action();
      TIMES.push(`${command}: ${Math.round((Date.now() - started) / 1000)} s`);
      expect(outcome.code, show(command, outcome)).toBe(0);
      return outcome;
    };

    try {
      for (const command of before) {
        if (command === 'cd deploy/demo') {
          cwd = demo;
        } else if (command === 'cp .env.example .env') {
          await timed(command, async () => {
            writeFileSync(join(demo, '.env'), envFile(settings(port)));
            return { code: 0, stdout: '', stderr: '' };
          });
          const config = await run(['compose', 'config', '--format', 'json'], demo, env);
          expect((JSON.parse(config.stdout) as { name: string }).name).toBe(project);
        } else if (BUILD.test(command)) {
          const started = Date.now();
          const code = await build(clone, ['build', '-f', 'deploy/docker/Dockerfile', '-t', IMAGE, '.']);
          TIMES.push(`${command}: ${Math.round((Date.now() - started) / 1000)} s`);
          expect(code, command).toBe(0);
        } else {
          const args = command.split(' ').slice(1);
          const outcome = await timed(command, () => run(args, cwd, env));
          if (args[0] === 'compose' && args.includes('test-source')) expect(outcome.stdout).toContain('Read-only: not verified');
        }
      }
      await checks(port, () => TIMES.push(`first command to the case's answer through the API: ${Math.round((Date.now() - began) / 1000)} s`));
      for (const command of after) {
        const args = command.split(' ').slice(1);
        await timed(command, () => run(args, cwd, env));
      }
      TIMES.push(`the whole path: ${Math.round((Date.now() - began) / 1000)} s`);
    } finally {
      process.stderr.write(`${TIMES.join('\n')}\n`);
      await cleanUp(project, demo);
    }
    expect(await remaining(project)).toBe('');

    await failures(demo);
  });
});

interface Ref {
  readonly sourceId: string;
  readonly entityType: string;
  readonly stableId: string;
}
interface Node {
  readonly ref: Ref;
}
interface Edge {
  readonly ref: Record<string, unknown>;
  readonly from: Ref;
  readonly to: Ref;
}
interface Page {
  readonly neighborType: string;
  readonly returned: number;
  readonly hasMore: boolean;
}
interface Expanded {
  readonly pageSize: number;
  readonly nodes: Node[];
  readonly edges: Edge[];
  readonly pages: Page[];
}
interface Investigation {
  readonly id: string;
  readonly version: number;
  readonly status: string;
}

const JSON_HEADERS = { 'content-type': 'application/json' };

async function call(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ readonly status: number; readonly json: unknown; readonly text: string }> {
  const response = await fetch(`${base}${path}`, { method, headers: { ...(body === undefined ? {} : JSON_HEADERS), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

const record = (label: string, value: unknown): void => void process.stderr.write(`${label}: ${JSON.stringify(value)}\n`);

async function failures(demo: string): Promise<void> {
  const attempt = async (values: Record<string, string | undefined>, args: readonly string[]): Promise<{ readonly outcome: Outcome; readonly project: string }> => {
    const project = projectName();
    writeFileSync(join(demo, '.env'), envFile(values));
    try {
      return { outcome: await run(args, demo, { COMPOSE_PROJECT_NAME: project }), project };
    } finally {
      await cleanUp(project, demo);
    }
  };
  const port = await otherThan8080();

  const blank = await attempt(settings(port, { NEBURYX_CURSOR_KEY: '' }), ['compose', 'config', '--format', 'json']);
  expect(blank.outcome.code).not.toBe(0);
  expect(blank.outcome.stderr).toContain('set NEBURYX_CURSOR_KEY in the .env file');

  const missing = await attempt(settings(port, { NEBURYX_TAG: 'does-not-exist' }), ['compose', 'up', '--wait']);
  expect(missing.outcome.code, show('missing image', missing.outcome)).not.toBe(0);
  expect((await docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${missing.project}`])).stdout.trim()).toBe('');

  const held = await listener();
  const taken = await attempt(settings(held.port), ['compose', 'up', '--wait']);
  expect(taken.outcome.code, show('port held', taken.outcome)).not.toBe(0);
  await closed(held.server);
}

interface CaseFile {
  readonly preset: { readonly entity: { readonly type: string; readonly id: string }; readonly case_ref: string };
  readonly cases: readonly { readonly expect: readonly { readonly node: { readonly type: string; readonly id: string }; readonly via?: string; readonly ids?: readonly string[]; readonly count?: number }[] }[];
}

/** Every word of the banking pack this test uses comes from the pack's own files, so no pack word is written here. */
function packFacts() {
  const folder = join(repository, 'domain-packs/banking-fraud');
  const cases = parse(readFileSync(join(folder, 'cases.yaml'), 'utf8')) as CaseFile;
  const mapping = parse(readFileSync(join(folder, 'neburyx.yaml'), 'utf8')) as { sources: { id: string }[] };
  const [device, address] = (cases.cases[0]?.expect ?? []).filter((row) => row.ids !== undefined);
  const stop = (cases.cases[1]?.expect ?? []).find((row) => row.count !== undefined);
  if (device?.ids === undefined || address?.ids === undefined || device.via === undefined || address.via === undefined || stop?.via === undefined) throw new Error('the pack cases are not as the test reads them');
  return { source: mapping.sources[0]?.id ?? '', start: cases.preset.entity, caseRef: cases.preset.case_ref, device: { ...device, via: device.via, ids: device.ids }, address: { ...address, via: address.via, ids: address.ids }, stop: { ...stop, via: stop.via } };
}

async function checks(port: number, answered: () => void): Promise<void> {
  const base = `http://127.0.0.1:${port}`;
  const facts = packFacts();
  const source = facts.source;
  const sources = (await call(base, 'GET', '/v1/sources')).json as { items: { id: string; alias: string; synthetic: boolean; demoCase: { entityType: string; stableId: string; caseRef: string } | null }[] };
  const banking = sources.items.find((item) => item.id === source);
  expect(banking?.alias).toBe(source);
  expect(banking?.synthetic).toBe(true);
  expect(banking?.demoCase).toEqual({ entityType: facts.start.type, stableId: facts.start.id, caseRef: facts.caseRef });
  const ref = (entityType: string, stableId: string): Ref => ({ sourceId: source, entityType, stableId });

  const opened = await call(base, 'POST', '/v1/investigations', { sourceId: source, entity: ref(facts.start.type, facts.start.id), caseRef: facts.caseRef, mask: false });
  expect([200, 201]).toContain(opened.status);
  let investigation = (opened.json as { investigation: Investigation }).investigation;
  expect((opened.json as { entity?: { ref: Ref } }).entity?.ref.stableId).toBe(facts.start.id);

  const expand = async (from: { readonly type: string; readonly id: string }, via: string, neighborType: string, direction: 'in' | 'out'): Promise<Expanded> => {
    const answer = await call(base, 'POST', '/v1/graph/expand', { sourceId: source, ref: { entityType: from.type, stableId: from.id }, relTypes: [via], neighborTypes: [neighborType], direction });
    expect(answer.status, answer.text.slice(0, 500)).toBe(200);
    return answer.json as Expanded;
  };
  const ids = (expanded: Expanded, entityType: string): string[] => expanded.nodes.filter((node) => node.ref.entityType === entityType).map((node) => node.ref.stableId).sort();

  const SIX = [...facts.device.ids].sort();
  const devices = await expand(facts.start, facts.device.via, facts.device.node.type, 'out');
  expect(ids(devices, facts.device.node.type)).toContain(facts.device.node.id);
  const onDevice = await expand(facts.device.node, facts.device.via, facts.start.type, 'in');
  expect(ids(onDevice, facts.start.type)).toEqual(SIX);
  const onAddress = await expand(facts.address.node, facts.address.via, facts.start.type, 'in');
  expect(ids(onAddress, facts.start.type)).toEqual(SIX);

  const edge = onDevice.edges[0];
  expect(edge).toBeDefined();
  const segment = Buffer.from(JSON.stringify(edge?.ref)).toString('base64url');
  const detail = (await call(base, 'GET', `/v1/edges/${segment}`)).json as { semantics: string; evidence: { status: string; records?: unknown[] } };
  expect(detail.semantics).toBe('stored');
  expect(detail.evidence.status).toBe('available');
  expect(detail.evidence.records?.length ?? 0).toBeGreaterThan(0);

  const found = await call(base, 'POST', '/v1/search/entities', { sourceId: source, text: facts.stop.node.id });
  expect(found.status, found.text.slice(0, 300)).toBe(200);
  const exact = (found.json as { exact: Node[] }).exact;
  expect(exact.map((node) => node.ref.stableId)).toEqual([facts.stop.node.id]);
  const preview = (await call(base, 'POST', '/v1/graph/preview-expansion', { sourceId: source, ref: { entityType: facts.stop.node.type, stableId: facts.stop.node.id }, mask: false })).json;
  const stopList = await expand(facts.stop.node, facts.stop.via, facts.start.type, 'in');
  record('stop-list preview', preview);
  record('stop-list page', { pageSize: stopList.pageSize, nodes: stopList.nodes.length, pages: stopList.pages });
  const total = (preview as { total: { value: number; quality: string } }).total;
  expect(total.value).toBe(facts.stop.count);
  expect(total.quality).toBe('exact');
  expect(stopList.pageSize).toBe(BUDGET_DEFAULTS.defaultPage);
  expect(stopList.pages[0]?.returned).toBe(BUDGET_DEFAULTS.defaultPage);
  expect(stopList.pages[0]?.hasMore).toBe(true);
  answered();

  const closed = await call(base, 'POST', `/v1/investigations/${investigation.id}/status`, { status: 'closed', expectedVersion: investigation.version });
  expect(closed.status).toBe(200);
  investigation = (closed.json as { investigation: Investigation }).investigation;
  expect(investigation.status).toBe('closed');
  const exportBody = { kind: 'view', format: 'json', entities: SIX.map((id) => ref(facts.start.type, id)), edges: [], aggregates: [], derived: [] };
  const made = await call(base, 'POST', `/v1/investigations/${investigation.id}/exports`, exportBody, { 'idempotency-key': randomBytes(16).toString('hex') });
  expect(made.status, made.text.slice(0, 500)).toBe(201);
  const file = await call(base, 'GET', `/v1/exports/${(made.json as { id: string }).id}/download`);
  expect(file.status).toBe(200);
  const header = (JSON.parse(file.text) as { header: { lines: string[] } }).header.lines;
  record('export header', header);
  for (const prefix of ['source:', 'exported:', 'scope:', 'coverage:', 'masking:']) expect(header.some((line) => line.startsWith(prefix)), prefix).toBe(true);
  expect(header.find((line) => line.startsWith('scope:'))).toContain('partial');
  const reopened = await call(base, 'POST', `/v1/investigations/${investigation.id}/status`, { status: 'open', expectedVersion: investigation.version });
  investigation = (reopened.json as { investigation: Investigation }).investigation;
  expect(investigation.status).toBe('open');
  const deleted = await call(base, 'DELETE', `/v1/investigations/${investigation.id}`, undefined, { 'if-match': `"${investigation.version}"` });
  expect(deleted.status).toBe(200);
  const gone = deleted.json as { version: number };
  const list = (await call(base, 'GET', '/v1/investigations?deleted=true')).json as { items: { id: string }[]; retention: { deletedInvestigationsDays: number } };
  expect(list.items.map((item) => item.id)).toContain(investigation.id);
  expect(list.retention.deletedInvestigationsDays).toBe(RETENTION_DEFAULTS.deletedInvestigationsDays);
  const restored = await call(base, 'POST', `/v1/investigations/${investigation.id}/restore`, { expectedVersion: gone.version });
  expect(restored.status, restored.text.slice(0, 300)).toBe(200);
  const live = (await call(base, 'GET', '/v1/investigations')).json as { items: { id: string }[] };
  expect(live.items.map((item) => item.id)).toContain(investigation.id);
}
