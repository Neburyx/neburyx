import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { forwardTo, type Forwarder } from '@neburyx/test-neo4j';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { createSourceGate, type SourceGate } from '../gate/source-gate.js';
import { SCHEMA_DRAFT_CAP } from '../gate/templates/schema-draft.js';
import { parseMapping } from '../mapping/load.js';
import { communitySeams } from '../seams/community-seams.js';
import { createSourceTester } from '../source-test/tester.js';
import { memoryAppStore } from '../testing/app-store.js';
import { LOCAL_PRINCIPAL } from '../testing/gate.js';
import { envFor, NEO4J_ENV_PASSWORD, NEO4J_ENV_USER, runAdmin, runAll, startNeo4j, type RunningNeo4j } from '../testing/neo4j-server.js';
import { runInitCommand } from './command.js';

// The demo graph tool is a developer tool that the product may not import, so the graph is built the way a person builds it: by running its command line.
const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const TOOL = join(repoRoot, 'tools', 'demo-graph', 'dist', 'main.js');
const PACK = 'banking-fraud';
const PLANTED = 'planted-value-7f3a91c2-not-a-schema-name';
const folder = mkdtempSync(join(tmpdir(), 'init-neo4j-'));
const closers: (() => Promise<unknown>)[] = [];

interface Started {
  readonly server: RunningNeo4j;
  readonly uri: string;
}

async function start(): Promise<Started> {
  const server = await startNeo4j();
  const forwarder: Forwarder = await forwardTo(server.boltUri);
  closers.push(() => forwarder.close(), () => server.stop());
  return { server, uri: forwarder.uri };
}

async function initOn(started: Started): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runInitCommand(
    ['--source', 'own-source', '--uri', started.uri, '--database', started.server.database, '--username-env', NEO4J_ENV_USER, '--password-env', NEO4J_ENV_PASSWORD],
    envFor(started.server),
    { stdout: { write: (text) => out.push(text) }, stderr: { write: (text) => err.push(text) } },
  );
  return { code, stdout: out.join(''), stderr: err.join('') };
}

async function counts(server: RunningNeo4j): Promise<string> {
  const session = server.admin.session({ database: server.database });
  try {
    const result = await session.run('MATCH (n) WITH count(n) AS nodes, sum(size(keys(n))) AS properties OPTIONAL MATCH ()-[r]->() RETURN nodes, properties, count(r) AS relationships');
    return JSON.stringify(result.records[0]?.toObject());
  } finally {
    await session.close();
  }
}

let banking: Started | undefined;
let beforeInit = '';

beforeAll(async () => {
  await run('pnpm', ['--filter', '@neburyx/demo-graph', 'build'], { cwd: repoRoot });
  banking = await start();
  const pack = readFileSync(join(repoRoot, 'domain-packs', PACK, 'neburyx.yaml'), 'utf8').replace(/^(\s*database:\s*)neo4j\s*$/m, `$1${banking.server.database}`);
  const mapping = join(folder, 'pack.yaml');
  writeFileSync(mapping, pack);
  await run('node', [TOOL, 'build', '--mapping', mapping, '--definition', join(repoRoot, 'domain-packs', PACK, 'demo.yaml'), '--uri', banking.uri], {
    cwd: repoRoot,
    env: { ...process.env, DEMO_NEO4J_USER: banking.server.user, DEMO_NEO4J_PASSWORD: banking.server.password },
  });
  await runAdmin(banking.server, 'CALL db.awaitIndexes(120)');
  await runAdmin(banking.server, 'MATCH (n:Account) WITH n LIMIT 1 SET n.planted_note = $value', { value: PLANTED });
  beforeInit = await counts(banking.server);
}, 600_000);

afterAll(async () => {
  await runAll([...closers.map((close) => () => close())]);
  rmSync(folder, { recursive: true, force: true });
});

function bankingStarted(): Started {
  if (banking === undefined) throw new Error('no banking graph');
  return banking;
}

const pack = (): ReturnType<typeof parseMapping>['sources'][number] => {
  const [source] = parseMapping(readFileSync(join(repoRoot, 'domain-packs', PACK, 'neburyx.yaml'), 'utf8'), 'neburyx.yaml').sources;
  if (source === undefined) throw new Error('the pack has no source');
  return source;
};

describe('neburyx init against the banking demo graph', () => {
  it('lists the labels, relationship types, property keys, indexes and constraints of the graph', async () => {
    const { code, stdout } = await initOn(bankingStarted());
    expect(code).toBe(0);
    const document = parse(stdout) as { sources: { entities: { label: string }[]; relationships: { type: string }[] }[] };
    const [source] = document.sources;
    for (const entity of pack().entities) expect(source?.entities.map((item) => item.label)).toContain(entity.label);
    for (const relationship of pack().relationships) expect(source?.relationships.map((item) => item.type)).toContain(relationship.type);
    for (const entity of pack().entities) {
      // wherever the line falls: the server names the indexes and constraints the demo tool leaves unnamed, and a fresh database has lookup indexes of its own
      expect(stdout, `a constraint line for ${entity.label}`).toMatch(new RegExp(`#   \\S+: \\w*UNIQUENESS on label ${entity.label}, properties [^\\n]*\\b${entity.stableId}\\b`));
      expect(stdout, `a stable ID candidate comment for ${entity.label}`).toMatch(new RegExp(`# stable ID: [^\\n]*constraint of this label: [^\\n]*\\b${entity.stableId}\\b[^\\n]*\\n\\s+stable_id: TODO`));
    }
    expect(stdout).toMatch(/#   \S+: (RANGE|TEXT) on label \w+, properties/);
    expect(stdout).toContain('# Property keys (database-wide):');
    expect(stdout).toContain('planted_note');
    // for the guide's worked run: the draft of this graph, with the address of the server replaced
    const save = process.env['NBX_INIT_DRAFT_OUT'];
    if (save !== undefined) writeFileSync(save, stdout.replace(/uri: "[^"]*"/, 'uri: "bolt://graph.example:7687"'));
  });

  it('holds no property value: the value planted in a node appears nowhere in the output', async () => {
    const { stdout, stderr } = await initOn(bankingStarted());
    expect(stdout).not.toContain(PLANTED);
    expect(stderr).not.toContain(PLANTED);
  });

  it('makes a draft that test-source accepts once its markers are filled in for the pack', async () => {
    const { stdout } = await initOn(bankingStarted());
    const draft = parse(stdout) as { sources: { entities: { type: string; label: string; stable_id: string }[]; relationships: { type: string; from: string; to: string }[]; uri: string }[] };
    const [source] = draft.sources;
    if (source === undefined) throw new Error('no source in the draft');
    const labelOf = new Map(pack().entities.map((entity) => [entity.type, entity.label]));
    const stableOf = new Map(pack().entities.map((entity) => [entity.label, entity.stableId]));
    source.entities = source.entities.filter((entity) => stableOf.has(entity.label)).map((entity) => ({ ...entity, stable_id: stableOf.get(entity.label) ?? '' }));
    const types = new Map(pack().relationships.map((relationship) => [relationship.type, relationship]));
    source.relationships = source.relationships.filter((relationship) => types.has(relationship.type)).map((relationship) => {
      const model = types.get(relationship.type);
      return { ...relationship, from: labelOf.get(model?.from ?? '') ?? '', to: labelOf.get(model?.to ?? '') ?? '' };
    });
    const [filled] = parseMapping(stringify(draft), 'draft.yaml').sources;
    if (filled === undefined) throw new Error('the filled draft has no source');
    const mapping = { sources: [filled] };
    const gate: SourceGate = createSourceGate({ mapping, env: envFor(bankingStarted().server), seams: communitySeams(), logger: { warn: () => undefined } });
    closers.push(() => gate.close());
    const report = await createSourceTester({ gate: gate.gate, mapping, store: memoryAppStore() }).run({ traceId: 'tr-init', principal: LOCAL_PRINCIPAL, sourceId: filled.id });
    expect(report.outcome).not.toBe('fail');
    expect(report.mappingChecks.findings.filter((finding) => finding.severity === 'fail')).toEqual([]);
  });

  it('writes nothing to the database: its nodes, properties and relationships are as they were', async () => {
    await initOn(bankingStarted());
    expect(await counts(bankingStarted().server)).toBe(beforeInit);
  });
});

describe('neburyx init against a database with more labels, relationship types and property keys than the bound', () => {
  it('says each of the three lists was cut and lists the bound of each', async () => {
    const started = await start();
    const names = (prefix: string): string[] => Array.from({ length: SCHEMA_DRAFT_CAP + 1 }, (_value, index) => `${prefix}${String(index).padStart(4, '0')}`);
    await runAdmin(started.server, `CREATE ${names('L').map((label) => `(:${label})`).join(', ')}`);
    await runAdmin(started.server, `CREATE ${names('T').map((type) => `(:Anchor)-[:${type}]->(:Sink)`).join(', ')}`);
    await runAdmin(started.server, `CREATE (:Keys {${names('k').map((key) => `${key}: 1`).join(', ')}})`);
    const { code, stdout, stderr } = await initOn(started);
    expect(code).toBe(0);
    for (const kind of ['labels', 'relationship types', 'property keys']) expect(stdout).toContain(`# NOTE: the database has more than ${SCHEMA_DRAFT_CAP} ${kind}; the list of ${kind} below is partial.`);
    const document = parse(stdout) as { sources: { entities: unknown[]; relationships: unknown[] }[] };
    expect(document.sources[0]?.entities).toHaveLength(SCHEMA_DRAFT_CAP);
    expect(document.sources[0]?.relationships).toHaveLength(SCHEMA_DRAFT_CAP);
    const keys = /# Property keys \(database-wide\): ([^\n]*)/.exec(stdout)?.[1]?.split(', ') ?? [];
    expect(keys).toHaveLength(SCHEMA_DRAFT_CAP);
    expect(stderr).toContain('more than the bound of labels, relationship types, property keys');
  }, 300_000);
});
