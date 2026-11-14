import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { askPlanSchema, askRunResponseSchema, type AskPlan, type AskPlanner, type AskSummary } from '@neburyx/contracts';
import { createEnterpriseExtension } from '@neburyx/ee-ask';
import { forwardTo, type Forwarder } from '@neburyx/test-neo4j';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { buildApp } from '../app.js';
import { createSourceGate, type SourceGate } from '../gate/source-gate.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import type { SourceModel } from '../mapping/model.js';
import { communitySeams } from '../seams/community-seams.js';
import type { Seams } from '../seams/seams.js';
import { memoryAppStore } from '../testing/app-store.js';
import { createListPlanStore } from '../testing/list-plan-store.js';
import { NEO4J_SERIES, runAdmin, runAll, startNeo4j, type RunningNeo4j } from '../testing/neo4j-server.js';
import { principalFixture } from '../testing/principal-fixture.js';
import { makeWebRoot } from '../testing/web-root.js';
import { rmSync as removeFolder } from 'node:fs';

vi.mock('@neburyx/ee-audit', () => ({ createAuditSink: () => ({ sink: { record: () => Promise.resolve() }, close: async () => undefined }) }));

// The demo graph tool is a developer tool that the product may not import, so the graphs are built the way a person builds them: by running its command line.
const run = promisify(execFile);
const repoRoot = new URL('../../../../', import.meta.url).pathname;
const TOOL = join(repoRoot, 'tools', 'demo-graph', 'dist', 'main.js');
const PACKS = ['banking-fraud', 'insurance-claims'] as const;
const QUESTIONS = join(repoRoot, 'services', 'api', 'tests', 'ask', 'questions.yaml');
const REPLAY = join(repoRoot, 'services', 'api', 'tests', 'ask', 'replies.json');

interface DemoQuestion {
  readonly id: string;
  readonly pack: string;
  readonly wording: string;
  readonly expect: { readonly kind: string };
}

const questions = (parse(readFileSync(QUESTIONS, 'utf8')) as { questions: DemoQuestion[] }).questions;
const replay = JSON.parse(readFileSync(REPLAY, 'utf8')) as Record<string, { plan: string; repair?: string }>;

const servers = new Map<string, RunningNeo4j>();
const forwarders: Forwarder[] = [];
const gates: SourceGate[] = [];
const folder = mkdtempSync(join(tmpdir(), 'demo-chain-neo4j-'));
const webRoot = makeWebRoot();
const quote = (name: string): string => `\`${name}\``;

function mappingFile(pack: string, server: RunningNeo4j): string {
  const text = readFileSync(join(repoRoot, 'domain-packs', pack, 'neburyx.yaml'), 'utf8').replace(/^(\s*database:\s*)neo4j\s*$/m, `$1${server.database}`);
  if (!text.includes(`database: ${server.database}`)) throw new Error(`the ${pack} mapping does not name the default database`);
  const file = join(folder, `${pack}.yaml`);
  writeFileSync(file, text);
  return file;
}

function sourceOf(pack: string): SourceModel {
  const server = servers.get(pack);
  if (server === undefined) throw new Error(`no server for ${pack}`);
  const text = readFileSync(mappingFile(pack, server), 'utf8').replace(/uri: "[^"]+"/, `uri: "${server.boltUri}"`);
  const [source] = parseMapping(text, 'neburyx.yaml').sources;
  if (source === undefined) throw new Error(`the ${pack} pack has no source`);
  return source;
}

beforeAll(async () => {
  await run('pnpm', ['--filter', '@neburyx/demo-graph', 'build'], { cwd: repoRoot });
  const started = await Promise.all(PACKS.map(async (pack) => [pack, await startNeo4j()] as const));
  for (const [pack, server] of started) servers.set(pack, server);
  for (const [pack, server] of started) {
    const forwarder = await forwardTo(server.boltUri);
    forwarders.push(forwarder);
    await run('node', [TOOL, 'build', '--mapping', mappingFile(pack, server), '--definition', join(repoRoot, 'domain-packs', pack, 'demo.yaml'), '--uri', forwarder.uri], { cwd: repoRoot, env: { ...process.env, DEMO_NEO4J_USER: server.user, DEMO_NEO4J_PASSWORD: server.password } });
    await runAdmin(server, 'CALL db.awaitIndexes(120)');
  }
}, 600_000);

afterAll(async () => {
  await runAll([...gates.map((gate) => () => gate.close()), ...forwarders.map((forwarder) => () => forwarder.close()), ...[...servers.values()].map((server) => () => server.stop())]);
  rmSync(folder, { recursive: true, force: true });
  removeFolder(webRoot, { recursive: true, force: true });
});

/** The one JSON object of a recorded reply, which may have a sentence before it or a fence around it. */
function planOf(wording: string): AskPlan {
  const entry = replay[wording];
  if (entry === undefined) throw new Error(`the replay has no entry for the question ${wording.length} characters long`);
  for (const text of [entry.repair, entry.plan]) {
    if (text === undefined) continue;
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) continue;
    try {
      const parsed = askPlanSchema.safeParse(JSON.parse(text.slice(start, end + 1)));
      if (parsed.success) return parsed.data;
    } catch {
      // try the other reply
    }
  }
  throw new Error('the replay holds no plan for the question');
}

/** The stable ID of the n-th entity of a type in the demo graph, so that a placeholder stands for a record that exists. */
async function entityOf(pack: string, entityType: string, n: number): Promise<{ entityType: string; stableId: string }> {
  const server = servers.get(pack);
  const source = sourceOf(pack);
  const entity = source.entities.find((candidate) => candidate.type === entityType);
  if (server === undefined || entity === undefined) throw new Error(`no entity type ${entityType} in the ${pack} pack`);
  const session = server.admin.session({ database: server.database });
  try {
    const result = await session.run(`MATCH (n:${quote(entity.label)}) WHERE n.${quote(entity.stableId)} IS NOT NULL RETURN n.${quote(entity.stableId)} AS id ORDER BY id SKIP $skip LIMIT 1`, { skip: neo4jInt(n - 1) });
    const id = result.records[0]?.get('id');
    if (id === undefined) throw new Error(`the demo graph holds no ${entityType} number ${n}`);
    return { entityType, stableId: String(id) };
  } finally {
    await session.close();
  }
}

const neo4jInt = (value: number): { low: number; high: number } => ({ low: value, high: 0 });

const PLACEHOLDER = /^‹([A-Za-z0-9_-]+)#([1-9][0-9]*)›$/;

/** The plan with each placeholder turned into a record of the demo graph (and the value placeholder into a quoted reference), as the plan route does with what the investigator resolved. */
async function hydrated(pack: string, value: unknown): Promise<unknown> {
  if (Array.isArray(value)) return Promise.all(value.map((item) => hydrated(pack, item)));
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const stable = record['stableId'];
    if (typeof stable === 'string' && PLACEHOLDER.test(stable)) {
      const [, kind, number] = PLACEHOLDER.exec(stable) ?? [];
      return entityOf(pack, String(record['entityType'] ?? kind), Number(number));
    }
    return Object.fromEntries(await Promise.all(Object.entries(record).map(async ([key, item]) => [key, await hydrated(pack, item)])));
  }
  if (typeof value === 'string' && PLACEHOLDER.test(value)) return 'REF-1';
  return value;
}

const available: AskPlanner = { availability: () => ({ available: true }), plan: () => Promise.reject(new Error('not used')) };

async function started(pack: string) {
  const mapping = { sources: [sourceOf(pack)] };
  const server = servers.get(pack);
  if (server === undefined) throw new Error('no server');
  const gate = createSourceGate({ mapping, env: { DEMO_NEO4J_USER: server.reader.user, DEMO_NEO4J_PASSWORD: server.reader.password }, seams: communitySeams(), logger: { warn: () => undefined } });
  gates.push(gate);
  const plans = createListPlanStore();
  const seams = communitySeams();
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping, gate: gate.gate, seams: { ...seams, askPlanner: available } as Seams, extension: createEnterpriseExtension({ planStore: plans }), previewOn: true });
  return { app, plans, sourceId: mapping.sources[0]?.id ?? '' };
}

/** Every statement cites at least one key, every key is held, and every cited element is in the page the run answered. */
function checkCited(id: string, summary: AskSummary | undefined, result: unknown): void {
  if (summary === undefined) throw new Error(`the question ${id} has no summary`);
  const held = new Set(summary.citations.map((citation) => citation.key));
  const page = JSON.stringify(result);
  for (const sentence of summary.sentences) {
    if (sentence.cites.length === 0 || !sentence.cites.every((key) => held.has(key))) throw new Error(`the question ${id} has a statement that is not cited`);
  }
  for (const citation of summary.citations) if (!page.includes(JSON.stringify(citation.element))) throw new Error(`the question ${id} cites an element that is not in the page`);
}

describe.each(PACKS)(`every demo question of the %s pack, from the committed replay through the real run route and the real gate on ${NEO4J_SERIES}`, (pack) => {
  const mine = questions.filter((question) => question.pack === pack);

  it('has questions to run', () => {
    expect(mine.length).toBeGreaterThan(0);
  });

  it('runs each plan once on the demo graph, and every statement of each summary is cited with every cited element in the page; each refusal is a refusal of the replay and runs nothing', async () => {
    const rig = await started(pack);
    let ran = 0;
    let refused = 0;
    let summarized = 0;
    for (const [index, question] of mine.entries()) {
      const plan = planOf(question.wording);
      if (question.expect.kind === 'unsupported') {
        expect(plan.kind).toBe('unsupported');
        refused += 1;
        continue;
      }
      expect(plan.kind).toBe('plan');
      if (plan.kind !== 'plan') continue;
      const stored = rig.plans.put({ id: `0192f000-0000-7000-8000-${String(index + 1).padStart(12, '0')}`, userId: principalFixture.id, sourceId: rig.sourceId, templateId: plan.templateId, templateVersion: plan.templateVersion, params: (await hydrated(pack, plan.params)) as never });
      const response = await rig.app.inject({ method: 'POST', url: '/v1/ask/run', payload: { planId: stored.id } });
      if (response.statusCode !== 200) throw new Error(`the question ${question.id} ran with the status ${response.statusCode}`);
      const body = askRunResponseSchema.parse(response.json());
      ran += 1;
      // a run that lists nothing has no summary; one that lists something has a cited one
      if (body.summary !== undefined) {
        checkCited(question.id, body.summary, body.result);
        summarized += 1;
      }
    }
    expect(ran + refused).toBe(mine.length);
    expect(summarized).toBeGreaterThan(0);
    await rig.app.close();
  }, 300_000);
});
