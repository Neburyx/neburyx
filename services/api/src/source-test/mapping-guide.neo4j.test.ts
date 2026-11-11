import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { forwardTo, type Forwarder } from '@neburyx/test-neo4j';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSourceGate, type SourceGate } from '../gate/source-gate.js';
import { parseMapping } from '../mapping/load.js';
import { communitySeams } from '../seams/community-seams.js';
import { memoryAppStore } from '../testing/app-store.js';
import { LOCAL_PRINCIPAL } from '../testing/gate.js';
import { guideBlocks, guideText } from '../testing/guide.js';
import { runAdmin, runAll, startNeo4j, type RunningNeo4j } from '../testing/neo4j-server.js';
import { createSourceTester } from './tester.js';

// The demo graph tool is a developer tool that the product may not import, so the graph is built the way a person builds it: by running its command line.
const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const TOOL = join(repoRoot, 'tools', 'demo-graph', 'dist', 'main.js');
const PACK = 'banking-fraud';
const folder = mkdtempSync(join(tmpdir(), 'mapping-guide-neo4j-'));
const gates: SourceGate[] = [];
let server: RunningNeo4j | undefined;
let forwarder: Forwarder | undefined;

function runningServer(): RunningNeo4j {
  if (server === undefined) throw new Error('no server');
  return server;
}

beforeAll(async () => {
  await run('pnpm', ['--filter', '@neburyx/demo-graph', 'build'], { cwd: repoRoot });
  const started = await startNeo4j();
  server = started;
  forwarder = await forwardTo(started.boltUri);
  const pack = readFileSync(join(repoRoot, 'domain-packs', PACK, 'neburyx.yaml'), 'utf8').replace(/^(\s*database:\s*)neo4j\s*$/m, `$1${started.database}`);
  const mapping = join(folder, 'pack.yaml');
  writeFileSync(mapping, pack);
  await run('node', [TOOL, 'build', '--mapping', mapping, '--definition', join(repoRoot, 'domain-packs', PACK, 'demo.yaml'), '--uri', forwarder.uri], { cwd: repoRoot, env: { ...process.env, DEMO_NEO4J_USER: started.user, DEMO_NEO4J_PASSWORD: started.password } });
  await runAdmin(started, 'CALL db.awaitIndexes(120)');
}, 600_000);

afterAll(async () => {
  await runAll([...gates.map((gate) => () => gate.close()), ...(forwarder === undefined ? [] : [() => forwarder?.close() ?? Promise.resolve()]), ...(server === undefined ? [] : [() => runningServer().stop()])]);
  rmSync(folder, { recursive: true, force: true });
});

/** The last `yaml` block of the guide's worked example, with the address and database of this run in place of the demo network's. */
function workedExample(change: (text: string) => string = (text) => text) {
  const blocks = guideBlocks().filter((block) => block.info === 'yaml' && block.heading === 'A worked example');
  const last = blocks.at(-1);
  if (last === undefined) throw new Error('the guide has no worked example');
  const text = change(last.text).replace(/uri: "[^"]+"/, `uri: "${runningServer().boltUri}"`).replace(/^(\s*database:\s*)neo4j\s*$/m, `$1${runningServer().database}`);
  const [source] = parseMapping(text, 'neburyx.yaml').sources;
  if (source === undefined) throw new Error('the worked example has no source');
  return source;
}

async function report(source: ReturnType<typeof workedExample>) {
  const reader = runningServer().reader;
  const mapping = { sources: [source] };
  const gate = createSourceGate({ mapping, env: { DEMO_NEO4J_USER: reader.user, DEMO_NEO4J_PASSWORD: reader.password }, seams: communitySeams(), logger: { warn: () => undefined } });
  gates.push(gate);
  return createSourceTester({ gate: gate.gate, mapping, store: memoryAppStore() }).run({ traceId: 'tr-guide', principal: LOCAL_PRINCIPAL, sourceId: source.id });
}

describe('the mapping the guide builds on the banking demo graph', () => {
  it('passes test-source with no finding, and the login is inspected and cannot write', async () => {
    const found = await report(workedExample());
    expect(found.mappingChecks).toEqual({ status: 'pass', findings: [] });
    expect(found).toMatchObject({ outcome: 'pass', state: 'connected', stateReason: null, readOnlyCheck: 'privileges-inspected', loginCanWrite: false });
  });

  it('fails with the finding the guide quotes when a label is not the graph\'s', async () => {
    const found = await report(workedExample((text) => text.replace(/label: (\w+)/, (_match, label: string) => `label: ${label.replace('c', '')}`)));
    expect(found.outcome).toBe('fail');
    const [finding] = found.mappingChecks.findings;
    expect(finding).toMatchObject({ severity: 'fail', check: 'label' });
    expect(guideText()).toContain(`  fail: ${finding?.message ?? ''}`);
  });
});
