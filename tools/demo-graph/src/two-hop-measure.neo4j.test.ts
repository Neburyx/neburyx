import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import neo4j, { type QueryResult } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allowlistFromMapping } from '../../../services/api/src/gate/allowlist.js';
import { linkedEntitiesCountStatementOf, linkedEntitiesRequestOf, linkedEntitiesStatementOf } from '../../../services/api/src/gate/templates/linked-entities-statement.js';
import { parseMapping } from '../../../services/api/src/mapping/load.js';
import { baseSource, fileOf } from '../../../services/api/src/testing/mapping.js';
import { packMappingText, type Pack } from '../../../services/api/src/testing/pack-fixtures.js';
import { readCases } from './cases.js';
import { readDefinition } from './definition.js';
import { writeExport } from './export.js';
import { generate } from './generate.js';
import { loadExport } from './load.js';
import { readMappingSource } from './mapping.js';
import { packFiles } from './packs.js';
import { query, startNeo4j, type RunningNeo4j } from './testing/container.js';
import { scratch } from './testing/export-helpers.js';

/**
 * The measurement of the two-hop read of linked-entities and of its count (not a product read path and not a test: it asserts nothing about the numbers it prints). It runs the statements the gate writes for a linked-entities run and for its count, with PROFILE and as plain timed
 * runs, on the two demo packs and on synthetic fan-out graphs, and prints one JSON line for each run. It runs only when `NBX_MEASURE=1`, because it loads the packs and builds graphs of about 330,000 nodes.
 * Run it with `NBX_MEASURE=1 NBX_MEASURE_OUT=<file> pnpm exec vitest run --config vitest.neo4j.config.ts src/two-hop-measure.neo4j.test.ts` in `tools/demo-graph`.
 */
const MEASURE = process.env['NBX_MEASURE'] === '1';
const OUT = process.env['NBX_MEASURE_OUT'];
/** One line of the record: appended to the file `NBX_MEASURE_OUT` names, and printed. */
function record(line: string): void {
  if (OUT !== undefined) appendFileSync(OUT, `${line}\n`);
  // eslint-disable-next-line no-console
  console.log(line);
}
const TIMEOUT_MS = 5000;
const TIMED_RUNS = 5;
const THRESHOLDS = [500, 250, 100, 50] as const;

interface Profile {
  readonly dbHits: number;
  readonly rootRows: number;
  readonly maxOperatorRows: number;
}

interface Plan {
  readonly dbHits?: number;
  readonly rows?: number;
  readonly children?: readonly Plan[];
}

const numberOf = (value: unknown): number => (typeof value === 'number' ? value : typeof value === 'object' && value !== null && 'toNumber' in value && typeof value.toNumber === 'function' ? Number(value.toNumber()) : 0);

function profileOf(result: QueryResult): Profile {
  const tree = result.summary.profile as Plan | null;
  if (tree === null) throw new Error('the server returned no profile');
  const walk = (node: Plan): { dbHits: number; max: number } => {
    const children = (node.children ?? []).map(walk);
    return { dbHits: numberOf(node.dbHits) + children.reduce((sum, child) => sum + child.dbHits, 0), max: Math.max(numberOf(node.rows), ...children.map((child) => child.max)) };
  };
  const total = walk(tree);
  return { dbHits: total.dbHits, rootRows: numberOf(tree.rows), maxOperatorRows: total.max };
}

interface Subject {
  readonly name: string;
  readonly server: RunningNeo4j;
  readonly anchor: string;
  readonly params: Record<string, unknown>;
  readonly allowlist: ReturnType<typeof allowlistFromMapping>;
}

const subjects: Subject[] = [];
const servers: RunningNeo4j[] = [];
const startedAt = Date.now();

/** The names of the databases and logins on the server that the tests make (`nbx-test-` and `nbx_test_`), read through the admin connection of a run; no address or password is read or printed. */
async function testObjects(server: RunningNeo4j): Promise<{ readonly databases: readonly string[]; readonly users: readonly string[] }> {
  const session = server.admin.session({ database: 'system' });
  try {
    const databases = (await session.run("SHOW DATABASES YIELD name WHERE name STARTS WITH 'nbx-test-' RETURN name")).records.map((record) => String(record.get('name')));
    const users = (await session.run("SHOW USERS YIELD user WHERE user STARTS WITH 'nbx_test_' RETURN user")).records.map((record) => String(record.get('user')));
    return { databases, users };
  } finally {
    await session.close();
  }
}

/** The time a name carries (base 36, as `namesFor` writes it), so that what this run made can be told from another run's. */
const stampOf = (name: string): number => parseInt(/^nbx[-_]test[-_]([0-9a-z]+)[-_]/.exec(name)?.[1] ?? '0', 36);

const integerCandidate = (id: string): number | null => (/^-?\d+$/.test(id) && Number.isSafeInteger(Number(id)) ? Number(id) : null);

async function measure(subject: Subject, kind: 'run' | 'count', threshold: number): Promise<Record<string, unknown>> {
  const request = linkedEntitiesRequestOf(subject.allowlist, subject.params);
  const cypher = kind === 'run' ? linkedEntitiesStatementOf(subject.allowlist, request) : linkedEntitiesCountStatementOf(subject.allowlist, request);
  const candidate = integerCandidate(subject.anchor);
  const parameters = { stableId: subject.anchor, stableInteger: candidate === null ? null : neo4j.int(candidate), countCap: neo4j.int(threshold), limit: neo4j.int(25) };
  const once = async (profile: boolean): Promise<{ readonly ms: number; readonly result?: QueryResult; readonly timedOut: boolean }> => {
    const session = subject.server.admin.session({ database: subject.server.database });
    const started = performance.now();
    try {
      const transaction = await session.beginTransaction({ timeout: TIMEOUT_MS });
      try {
        const result = await transaction.run(`${profile ? 'PROFILE ' : ''}${cypher}`, parameters);
        return { ms: performance.now() - started, result, timedOut: false };
      } finally {
        await transaction.rollback().catch(() => undefined);
      }
    } catch (error) {
      if (error instanceof Error && /TransactionTimedOut|timeout|terminated/i.test(`${error.message} ${'code' in error ? String(error.code) : ''}`)) return { ms: performance.now() - started, timedOut: true };
      throw error;
    } finally {
      await session.close().catch(() => undefined);
    }
  };
  const profiled = await once(true);
  const times: number[] = [];
  let timedOut = profiled.timedOut;
  for (let index = 0; index < TIMED_RUNS && !timedOut; index += 1) {
    const plain = await once(false);
    timedOut = plain.timedOut;
    times.push(plain.ms);
  }
  const sorted = [...times].sort((left, right) => left - right);
  const profile = profiled.result === undefined ? undefined : profileOf(profiled.result);
  const answered = profiled.result?.records.length ?? 0;
  return { subject: subject.name, kind, threshold, rowsReturned: answered, ...(profile === undefined ? { profile: 'timed out under PROFILE' } : profile), medianMs: sorted.length === 0 ? null : Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0), timedOut };
}

function mappingOf(pack: Pack, server: RunningNeo4j) {
  const text = packMappingText(pack, server.boltUri, server.database);
  const model = parseMapping(text, 'neburyx.yaml');
  const [source] = model.sources;
  if (source === undefined) throw new Error('the pack has no source');
  return allowlistFromMapping(source);
}

async function loadPack(pack: Pack): Promise<{ readonly server: RunningNeo4j; readonly preset: string }> {
  const files = packFiles(pack);
  const mapping = readMappingSource(files.mapping);
  const definition = readDefinition(files.definition, mapping);
  const directory = join(scratch(), `export-${pack}`);
  writeExport(directory, generate(mapping, definition, definition.seed));
  const preset = readCases(files.cases, mapping, definition).preset.entity.id;
  const server = await startNeo4j();
  servers.push(server);
  await loadExport({ directory, source: { ...mapping, database: server.database }, override: server.boltUri, env: { [mapping.usernameEnv]: server.user, [mapping.passwordEnv]: server.password }, reset: false });
  return { server, preset };
}

const SYNTHETIC = parseMapping(
  fileOf(baseSource({ id: 'graph', entities: [{ type: 'maker', label: 'SMaker', stable_id: 'sid' }], relationships: [{ type: 'LINKS', from: 'maker', to: 'maker', stable_id: 'lid' }], derived: [], patterns: [] })),
  'neburyx.yaml',
);

/** For each threshold T: an anchor with T + 1 neighbors, each with T - 1 targets of its own, so that every neighbor has degree T counting the edge back to the anchor and none is left out as a supernode. */
async function buildSynthetic(server: RunningNeo4j): Promise<void> {
  await query(server, 'CREATE CONSTRAINT s_maker FOR (n:SMaker) REQUIRE n.sid IS UNIQUE');
  for (const threshold of THRESHOLDS) {
    await query(server, `CREATE (:SMaker {sid: 'a${threshold}'})`);
    await query(server, `MATCH (a:SMaker {sid: 'a${threshold}'}) UNWIND range(1, ${threshold + 1}) AS i CREATE (a)-[:LINKS {lid: 'a${threshold}-' + toString(i)}]->(:SMaker {sid: 'n${threshold}_' + toString(i)})`);
    for (let start = 1; start <= threshold + 1; start += 25) {
      const end = Math.min(start + 24, threshold + 1);
      await query(server, `UNWIND range(${start}, ${end}) AS i MATCH (n:SMaker {sid: 'n${threshold}_' + toString(i)}) UNWIND range(1, ${threshold - 1}) AS j CREATE (n)-[:LINKS {lid: 'n' + toString(i) + '-' + toString(j)}]->(:SMaker {sid: 't${threshold}_' + toString(i) + '_' + toString(j)})`);
    }
  }
  await query(server, 'CALL db.awaitIndexes(300)');
}

beforeAll(async () => {
  if (!MEASURE) return;
  const bank = await loadPack('banking-fraud');
  const bankAllowlist = mappingOf('banking-fraud', bank.server);
  const heaviest = await query(bank.server, `MATCH (a:Account)-[r:TRANSFERRED_TO]-() RETURN a.accountId AS id, count(r) AS degree ORDER BY degree DESC LIMIT 1`);
  const bankParams = { entityType: 'account', targetType: 'account', via: ['TRANSFERRED_TO'], direction: 'both', maxHops: 2 };
  subjects.push({ name: 'banking-fraud · Connected accounts · the preset account', server: bank.server, anchor: bank.preset, params: { ...bankParams, stableId: bank.preset }, allowlist: bankAllowlist });
  subjects.push({ name: 'banking-fraud · Connected accounts · the account with the most transfers', server: bank.server, anchor: String(heaviest[0]?.['id']), params: { ...bankParams, stableId: String(heaviest[0]?.['id']) }, allowlist: bankAllowlist });
  const insurance = await loadPack('insurance-claims');
  const insuranceAllowlist = mappingOf('insurance-claims', insurance.server);
  const claimant = await query(insurance.server, 'MATCH (c:Claimant)<-[r:FILED_BY]-() RETURN c.claimantId AS id, count(r) AS degree ORDER BY degree DESC LIMIT 1');
  const insuranceParams = { entityType: 'claimant', targetType: 'claim', via: ['FILED_BY'], direction: 'both', maxHops: 2 };
  subjects.push({ name: 'insurance-claims · Claims by claimant · the claimant with the most claims', server: insurance.server, anchor: String(claimant[0]?.['id']), params: { ...insuranceParams, stableId: String(claimant[0]?.['id']) }, allowlist: insuranceAllowlist });
  const synthetic = await startNeo4j();
  servers.push(synthetic);
  await buildSynthetic(synthetic);
  const allowlist = allowlistFromMapping(SYNTHETIC.sources[0] ?? (() => { throw new Error('no source'); })());
  for (const threshold of THRESHOLDS) subjects.push({ name: `synthetic fan-out T=${threshold}`, server: synthetic, anchor: `a${threshold}`, params: { entityType: 'maker', targetType: 'maker', via: ['LINKS'], direction: 'both', maxHops: 2, stableId: `a${threshold}` }, allowlist });
}, 3_600_000);

afterAll(async () => {
  if (!MEASURE) return;
  const mine = servers.map((server) => server.database);
  for (const server of servers) await server.stop().catch(() => undefined);
  // a run of the helper that makes and drops its own database lists what is on the server now, so that the leftovers of this run, if any, are named
  const checker = await startNeo4j();
  try {
    const after = await testObjects(checker);
    const leftovers = [...after.databases, ...after.users].filter((name) => name !== checker.database && !name.startsWith(checker.database.replace('nbx-test-', 'nbx_test_').replace(/-/g, '_')) && stampOf(name) >= Math.floor(startedAt / 1000) - 5000);
    record(`MEASURE-CLEANUP ${JSON.stringify({ databasesOfThisRun: mine, stillOnTheServer: mine.filter((name) => after.databases.includes(name)), otherObjectsFromAfterTheStart: leftovers.filter((name) => !mine.includes(name)) })}`);
  } finally {
    await checker.stop().catch(() => undefined);
  }
}, 600_000);

describe.skipIf(!MEASURE)('the measurement of the two-hop read of linked-entities and its count', () => {
  it('prints one line for each subject, threshold and statement', async () => {
    for (const subject of subjects) {
      const thresholds = subject.name.startsWith('synthetic') ? [Number(subject.name.split('=')[1])] : [...THRESHOLDS];
      for (const threshold of thresholds) {
        for (const kind of ['run', 'count'] as const) {
          record(`MEASURE ${JSON.stringify(await measure(subject, kind, threshold).catch((error: unknown) => ({ subject: subject.name, kind, threshold, error: error instanceof Error ? error.message : 'failed' })))}`);
        }
      }
    }
    expect(subjects.length).toBeGreaterThan(0);
  }, 3_600_000);
});
