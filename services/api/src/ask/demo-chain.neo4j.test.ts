import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { askAnswerSchema, readClassification, type AskClassification, type AskClassifier, type AskSummary } from '@neburyx/contracts';
import { citedKeysExist, listedElements } from '@neburyx/ee-ask';
import { forwardTo, type Forwarder } from '@neburyx/test-neo4j';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import neo4j from 'neo4j-driver';
import { buildApp } from '../app.js';
import { fileQueryDepsOf } from '../gate/file-query.js';
import { createSourceGate, type SourceGate } from '../gate/source-gate.js';
import type { Gate } from '../gate/types.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import type { SourceModel } from '../mapping/model.js';
import { communitySeams } from '../seams/community-seams.js';
import { memoryAppStore } from '../testing/app-store.js';
import { NEO4J_SERIES, runAdmin, runAll, startNeo4j, type RunningNeo4j } from '../testing/neo4j-server.js';
import { makeWebRoot } from '../testing/web-root.js';
import { configuredWith, copyOfAskFolder, demoPacks, removeDemoFolders, type DemoPack, type DemoQuestion } from '../testing/demo-packs.js';

// The demo graph tool is a developer tool that the product may not import, so the graphs are built the way a person builds them: by running its command line.
// Every name of the pack (its types, labels, properties) is read from its own files; none is written here.
/** The day the demo graphs are built for and the instant the application takes as now: every date of the graph is relative to the build day, so the windows of the questions find the same data on every run. */
const BUILD_DAY = '2026-11-14';
const NOW = new Date(`${BUILD_DAY}T12:00:00Z`);

const run = promisify(execFile);
const repoRoot = new URL('../../../../', import.meta.url).pathname;
const TOOL = join(repoRoot, 'tools', 'demo-graph', 'dist', 'main.js');
const packs = demoPacks();

const servers = new Map<string, RunningNeo4j>();
const forwarders: Forwarder[] = [];
const gates: SourceGate[] = [];
const folder = mkdtempSync(join(tmpdir(), 'demo-chain-neo4j-'));
const webRoot = makeWebRoot();
const logged: string[] = [];

function mappingFile(pack: DemoPack, server: RunningNeo4j): string {
  const text = readFileSync(join(pack.dir, 'neburyx.yaml'), 'utf8').replace(/^(\s*database:\s*)neo4j\s*$/m, `$1${server.database}`);
  if (!text.includes(`database: ${server.database}`)) throw new Error(`the ${pack.pack} mapping does not name the default database`);
  const file = join(folder, `${pack.pack}.yaml`);
  writeFileSync(file, text);
  return file;
}

function sourceOf(pack: DemoPack): SourceModel {
  const server = servers.get(pack.pack);
  if (server === undefined) throw new Error(`no server for ${pack.pack}`);
  const text = readFileSync(mappingFile(pack, server), 'utf8').replace(/uri: "[^"]+"/, `uri: "${server.boltUri}"`);
  const [source] = parseMapping(text, 'neburyx.yaml').sources;
  if (source === undefined) throw new Error(`the ${pack.pack} pack has no source`);
  return source;
}

beforeAll(async () => {
  await run('pnpm', ['--filter', '@neburyx/demo-graph', 'build'], { cwd: repoRoot });
  const started = await Promise.all(packs.map(async (pack) => [pack, await startNeo4j()] as const));
  for (const [pack, server] of started) servers.set(pack.pack, server);
  for (const [pack, server] of started) {
    const forwarder = await forwardTo(server.boltUri);
    forwarders.push(forwarder);
    await run('node', [TOOL, 'build', '--mapping', mappingFile(pack, server), '--definition', join(pack.dir, 'demo.yaml'), '--build-date', BUILD_DAY, '--uri', forwarder.uri], { cwd: repoRoot, env: { ...process.env, DEMO_NEO4J_USER: server.user, DEMO_NEO4J_PASSWORD: server.password } });
    await runAdmin(server, 'CALL db.awaitIndexes(120)');
  }
}, 600_000);

afterAll(async () => {
  await runAll([...gates.map((gate) => () => gate.close()), ...forwarders.map((forwarder) => () => forwarder.close()), ...[...servers.values()].map((server) => () => server.stop())]);
  rmSync(folder, { recursive: true, force: true });
  rmSync(webRoot, { recursive: true, force: true });
  removeDemoFolders();
});

/** The gate as the application sees it, with the text of any failure kept in `logged`, since the application's own log leaves the text of an unexpected failure out. */
function watched(inner: Gate): Gate {
  const keep = (error: unknown): never => {
    logged.push(`gate-failure: ${error instanceof Error ? `${error.name}: ${error.message} ${String((error as { reason?: unknown }).reason)}` : String(error)}`.slice(0, 600));
    throw error;
  };
  return { run: (request) => inner.run(request).catch(keep), runMany: (requests) => inner.runMany(requests).catch(keep), fileQuery: (request) => inner.fileQuery(request).catch(keep) };
}

function scriptedClassifier(pack: DemoPack, extra: ReadonlyMap<string, unknown>): AskClassifier {
  const names = Object.keys(pack.intents);
  return {
    availability: () => ({ available: true }),
    classify: async (input): Promise<AskClassification> => {
      const question = pack.questions.find((candidate) => candidate.wording === input.question);
      const text = JSON.stringify(extra.get(input.question) ?? (question === undefined || question.expect === 'refuse' ? { intent: null, entities: {} } : question.expect));
      const read = readClassification(text, names);
      if (!read.ok) return { ok: false, cause: read.cause };
      return read.intent === null ? { ok: false, cause: 'no-intent' } : { ok: true, intent: read.intent, entities: read.entities };
    },
  };
}

async function started(pack: DemoPack, extra: ReadonlyMap<string, unknown> = new Map(), askFolder?: string) {
  const server = servers.get(pack.pack);
  if (server === undefined) throw new Error('no server');
  const mapping = { sources: [sourceOf(pack)] };
  const { extension, outcome } = await configuredWith(askFolder ?? copyOfAskFolder(pack), [pack.sourceId]);
  expect(outcome).toEqual({ ok: true });
  const gate = createSourceGate({
    mapping,
    env: { DEMO_NEO4J_USER: server.reader.user, DEMO_NEO4J_PASSWORD: server.reader.password },
    seams: communitySeams(),
    logger: { warn: (...parts: unknown[]) => void logged.push(`gate-warn: ${JSON.stringify(parts).slice(0, 300)}`) },
    fileQueries: fileQueryDepsOf(() => extension.askFolder?.()),
  });
  gates.push(gate);
  const app = await buildApp({ webRoot, logger: createLogger({ write: (line: string) => void logged.push(line) }), store: memoryAppStore(), mapping, gate: watched(gate.gate), seams: { ...communitySeams(), askClassifier: scriptedClassifier(pack, extra) }, extension, previewOn: true, templateRunClock: () => NOW });
  return { app, server, sourceId: pack.sourceId };
}

/** How many nodes of the demo graph hold the text as any one of their properties: the entity of a question exists when it is at least one. */
async function holders(server: RunningNeo4j, text: string): Promise<number> {
  const session = server.admin.session({ database: server.database });
  try {
    const result = await session.run('MATCH (n) WHERE any(key IN keys(n) WHERE n[key] = $text) RETURN count(n) AS found', { text });
    return Number(result.records[0]?.get('found'));
  } finally {
    await session.close();
  }
}

/** Every statement cites at least one key, every key is held and every cited element is one the result lists: the product's own check. */
function checkCited(id: string, summary: AskSummary | undefined, result: Parameters<typeof listedElements>[0]): void {
  if (summary === undefined) throw new Error(`the question ${id} has no summary`);
  const listed = listedElements(result);
  if (listed === undefined || !citedKeysExist(summary, listed)) throw new Error(`the question ${id} has a statement or a citation that is not backed by the result`);
}

type Answer = ReturnType<typeof askAnswerSchema.parse>;
type Answered = Extract<Answer, { answered: unknown }>['answered'];
type Refused = Extract<Answer, { refused: unknown }>['refused'];
const readAnswer = (value: unknown): { readonly answered?: Answered; readonly refused?: Refused } => askAnswerSchema.parse(value);

/** How many rows the intent's own query returns for the text, as the product would count them before any cap. */
async function queryMatches(server: RunningNeo4j, query: string, name: string): Promise<number> {
  const session = server.admin.session({ database: server.database });
  try {
    const result = await session.run(query, { name });
    return result.records.length;
  } finally {
    await session.close();
  }
}

const isNameQuestion = (pack: DemoPack, question: DemoQuestion): boolean => question.expect !== 'refuse' && pack.intents[question.expect.intent]?.query !== undefined;
const post = (app: Awaited<ReturnType<typeof started>>['app'], url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: JSON.stringify(payload), headers: { 'content-type': 'application/json' } });

describe.each(packs.map((pack) => [pack.pack, pack] as const))(`every demo question of the %s pack, through the real route and the real gate on ${NEO4J_SERIES}`, (_name, pack: DemoPack) => {
  it('names only entities that exist in the demo graph, and a pair for the question of support that the rule links', async () => {
    const rig = await started(pack);
    try {
      for (const question of pack.questions) {
        if (question.expect === 'refuse' || isNameQuestion(pack, question)) continue;
        for (const value of Object.values(question.expect.entities)) expect(await holders(rig.server, value), `${question.id}: ${value}`).toBeGreaterThan(0);
        const settings = pack.intents[question.expect.intent]?.settings as { ruleId?: string; ends?: { entityType: string }[] } | undefined;
        if (settings?.ends !== undefined && settings.ruleId !== undefined) {
          const [first, second] = Object.values(question.expect.entities);
          const response = await post(rig.app, '/v1/graph/derived-neighbors', { sourceId: rig.sourceId, ref: { entityType: settings.ends[0]?.entityType, stableId: first } });
          expect(response.statusCode, question.id).toBe(200);
          const nodes = (response.json() as { results: { ruleId: string; nodes: { ref: { stableId: string } }[] }[] }).results.filter((result) => result.ruleId === settings.ruleId).flatMap((result) => result.nodes);
          expect(nodes.some((node) => node.ref.stableId === second), question.id).toBe(true);
        }
      }
    } finally {
      await rig.app.close();
    }
  }, 300_000);

  it('answers every question that expects an intent, with every statement of a summary cited and every cited element in the result; a heavy stop is continued; each refusal answers no-intent', async () => {
    const rig = await started(pack);
    let summarized = 0;
    try {
      for (const question of pack.questions) {
        const answer = await post(rig.app, '/v1/ask', { sourceId: rig.sourceId, question: question.wording });
        if (answer.statusCode !== 200) throw new Error(`the question ${question.id} answered ${answer.statusCode}: ${answer.body.slice(0, 400)} (${logged.slice(-4).join(' | ')})`);
        const body = readAnswer(answer.json());
        if (question.expect === 'refuse') {
          expect(body.refused?.cause, question.id).toBe('no-intent');
          continue;
        }
        if (body.refused !== undefined) {
          throw new Error(`the question ${question.id} was refused (${body.refused.cause})`);
        }
        let answered = body.answered;
        if (answered === undefined) throw new Error(`the question ${question.id} has neither an answer nor a refusal`);
        // only a heavy stop carries a token: a read that was cut at its bound is `partial` too, and its answer is the answer (the panel decides the same way, by the token and not by the outcome)
        if (answered.continueToken !== undefined) {
          const next = await post(rig.app, '/v1/ask/continue', { sourceId: rig.sourceId, intent: answered.intent, entities: answered.entities, continueToken: answered.continueToken });
          expect(next.statusCode, `${question.id} continue ${next.body.slice(0, 200)}`).toBe(200);
          answered = readAnswer(next.json()).answered;
          if (answered === undefined) throw new Error(`the question ${question.id} did not continue to an answer`);
        }
        const listed = listedElements(answered.result);
        if (listed === undefined || listed.size === 0) throw new Error(`the question ${question.id} lists nothing from the demo graph`);
        checkCited(question.id, answered.summary, answered.result);
        summarized += 1;
      }
      expect(logged.filter((line) => line.includes('ask-summary-dropped'))).toEqual([]);
      expect(summarized).toBeGreaterThan(0);
    } finally {
      await rig.app.close();
    }
  }, 600_000);

  it('returns the people of a name with an exact count when the matches fit the page, nothing-found for a name that is not there, and no name when the caller is masked', async () => {
    const question = pack.questions.find((candidate) => isNameQuestion(pack, candidate));
    if (question === undefined || question.expect === 'refuse') throw new Error('the pack has no name question');
    const [name] = Object.values(question.expect.entities);
    const intentName = question.expect.intent;
    const rig = await started(pack);
    try {
      const query = pack.intents[question.expect.intent]?.query ?? '';
      const matches = await queryMatches(rig.server, query, name ?? '');
      expect(matches, 'the demo graph holds the name').toBeGreaterThan(0);
      const open = readAnswer((await post(rig.app, '/v1/ask', { sourceId: rig.sourceId, question: question.wording, mask: false })).json());
      const result = open.answered?.result as { result?: { nodes: unknown[]; count: { quality: string; value: number } } } | undefined;
      expect(result?.result?.nodes.length).toBe(Math.min(matches, result?.result?.count.value ?? 0));
      if (result?.result?.count.quality === 'exact') expect(result.result.count.value).toBe(matches);
      const masked = readAnswer((await post(rig.app, '/v1/ask', { sourceId: rig.sourceId, question: question.wording, mask: true })).json());
      expect(masked.answered, 'the name query runs with masking on').toBeDefined();
      expect(JSON.stringify([masked.answered?.result, masked.answered?.summary])).not.toContain(name ?? '');
    } finally {
      await rig.app.close();
    }
    // a query with its own LIMIT below the row cap shows a cut result as exact: this is why the demo queries hold none
    const limited = started(pack, new Map(), copyOfAskFolder(pack, (subfolder) => writeFileSync(join(subfolder, 'intents.json'), JSON.stringify({ ...pack.intents, [intentName]: { ...pack.intents[intentName], query: `${pack.intents[intentName]?.query ?? ''} LIMIT 1` } }))));
    const cut = await limited;
    try {
      const all = await queryMatches(cut.server, pack.intents[intentName]?.query ?? '', name ?? '');
      const answer = readAnswer((await post(cut.app, '/v1/ask', { sourceId: cut.sourceId, question: question.wording, mask: false })).json());
      const count = (answer.answered?.result as { result?: { count: { quality: string; value: number } } } | undefined)?.result?.count;
      if (all > 1) expect(count).toMatchObject({ quality: 'exact', value: 1 });
    } finally {
      await cut.app.close();
    }
    const unknownName = 'Zed Zzzzz';
    const wording = `Who is ${unknownName}?`;
    const miss = await started(pack, new Map([[wording, { intent: question.expect.intent, entities: { name: unknownName } }]]));
    try {
      const refused = readAnswer((await post(miss.app, '/v1/ask', { sourceId: miss.sourceId, question: wording })).json());
      expect(refused.refused?.cause).toBe('nothing-found');
    } finally {
      await miss.app.close();
    }
  }, 300_000);
});
