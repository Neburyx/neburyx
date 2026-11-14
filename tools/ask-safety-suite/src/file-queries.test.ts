import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createEnterpriseExtension } from '@neburyx/ee-ask';
import { createLogger } from '../../../services/api/src/logger.js';
import { start, type StartIo } from '../../../services/api/src/start.js';
import { makeAskFolder, removeAskFolders } from '../../../services/api/src/testing/ask-folder.js';
import { memoryAppStore } from '../../../services/api/src/testing/app-store.js';
import { makeExportDirectory } from '../../../services/api/src/testing/export-directory.js';
import { baseSource } from '../../../services/api/src/testing/mapping.js';
import { makeWebRoot } from '../../../services/api/src/testing/web-root.js';
import { expectNoValue } from './checks.js';
import { FILE_QUERY, folderOf, handFolder, reply } from './fixtures.js';
import { recordingRunStore, startRig, type Rig } from './rig.js';
import { startModelStub, type ModelStub } from './stub.js';

vi.mock('@neburyx/ee-audit', async () => (await import('./mock-audit.js')).auditMock);

const webRoot = makeWebRoot();
const exportDirectory = makeExportDirectory();
const work = mkdtempSync(join(tmpdir(), 'ask-safety-'));
let stub: ModelStub;
beforeAll(async () => {
  stub = await startModelStub();
});
afterAll(async () => {
  removeAskFolders();
  rmSync(work, { recursive: true, force: true });
  await stub.close();
});

const DATABASE_URL = 'postgres://app_user@db.example.test:5432/neburyx';
const startIo = (stderr: string[]): StartIo => ({
  stderr: { write: (text: string) => stderr.push(text) },
  logger: createLogger({ write: () => undefined }),
  defaultWebRoot: webRoot,
  defaultExportDirectory: exportDirectory,
  openStore: memoryAppStore,
  tasks: [],
  portOverride: 0,
  extensionLoader: { load: async () => createEnterpriseExtension({ modelBaseUrl: stub.baseUrl }) },
});

describe('a folder whose file query writes, calls or reaches outside is refused at start-up', () => {
  const BAD: readonly (readonly [string, string])[] = [
    ['a write', "MATCH (n) WHERE n.x = 'SENTINEL_TEXT' DETACH DELETE n"],
    ['a procedure call', "CALL dbms.listConfig() YIELD name RETURN name // 'SENTINEL_TEXT'"],
    ['LOAD CSV', "LOAD CSV FROM 'file:///SENTINEL_TEXT.csv' AS row RETURN row"],
    ['a second statement', "MATCH (n) RETURN n; MATCH (m) RETURN m // 'SENTINEL_TEXT'"],
  ];

  it.each(BAD)('refuses a start for %s, naming the file and the intent, with no query text and no model call', async (_name, query) => {
    const file = join(work, 'ask-safety.yaml');
    writeFileSync(file, JSON.stringify({ sources: [baseSource({ id: 'demo' })], ai: { preview: true } }));
    const bad = makeAskFolder(['demo'], { wipe: { parameters: [], query } });
    const errors: string[] = [];
    stub.reset();
    expect(await start({ DATABASE_URL, NEBURYX_CONFIG: file, NEBURYX_PROFILE: 'enterprise', NEBURYX_ASK_API_KEY: 'SENTINEL-KEY', NEBURYX_ASK_MAPPING_FOLDER: bad }, startIo(errors))).toEqual({ exitCode: 1 });
    const text = errors.join('');
    expect(text).toContain('NEBURYX_ASK_MAPPING_FOLDER/demo/intents.json: intent "wipe"');
    expect(text).not.toMatch(/SENTINEL/);
    expect(stub.requests).toEqual([]);
  });

  it('refuses a start for a query that names a parameter the intent does not declare', async () => {
    const file = join(work, 'ask-safety-undeclared.yaml');
    writeFileSync(file, JSON.stringify({ sources: [baseSource({ id: 'demo' })], ai: { preview: true } }));
    const bad = makeAskFolder(['demo'], { find: { parameters: ['id'], query: 'MATCH (n) WHERE n.id = $id AND n.x = $other RETURN n' } });
    const errors: string[] = [];
    stub.reset();
    expect(await start({ DATABASE_URL, NEBURYX_CONFIG: file, NEBURYX_PROFILE: 'enterprise', NEBURYX_ASK_API_KEY: 'k', NEBURYX_ASK_MAPPING_FOLDER: bad }, startIo(errors))).toEqual({ exitCode: 1 });
    expect(errors.join('')).toContain('intent "find"');
    // the name of the parameter is named, as the problem is about it; the text of the query is not
    expect(errors.join('')).toContain('the parameter $other that is not declared');
    expect(errors.join('')).not.toMatch(/MATCH|RETURN|WHERE/);
    expect(stub.requests).toEqual([]);
  });
});

async function forcedRig(query: string, respond?: Parameters<typeof startRig>[0]['respond']): Promise<Rig> {
  const store = recordingRunStore();
  const extension = createEnterpriseExtension({ modelBaseUrl: stub.baseUrl, runStore: store.factory });
  // the extension's folder holds a harmless query under the name; the gate's own folder holds the query that was forced past the loader
  return startRig({ extension, stub, rows: store.rows, folder: folderOf(), gateFolder: () => handFolder({ byId: query }), ...(respond === undefined ? {} : { respond }) });
}

describe('a query forced past the loader is refused by the gate before any read', () => {
  const FORCED_WRITES = [
    ['a write', "MATCH (n:Widget) WHERE n.widgetId = $id SET n.x = 'SENTINEL_TEXT' RETURN n"],
    ['a procedure call', "MATCH (n:Widget) WHERE n.widgetId = $id CALL db.createLabel('SENTINEL_TEXT') RETURN n"],
    ['LOAD CSV', "LOAD CSV FROM 'file:///SENTINEL_TEXT.csv' AS row RETURN row"],
  ] as const;

  it.each(FORCED_WRITES)('answers the gate\'s refusal for %s: no read, a failed run, no summary and no query text anywhere', async (_name, query) => {
    const rig = await forcedRig(query);
    const answer = await rig.ask('Find it', reply('byId', { id: 'W-001' }));
    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({ error: { code: 'INVALID_REQUEST', details: { reason: 'file-query-text' } } });
    expect(answer.body['answered']).toBeUndefined();
    expect(rig.reads()).toEqual([]);
    expect(rig.appEvents.find((event) => event.action === 'ask.question')).toMatchObject({ result: 'failed' });
    expect(rig.rows).toEqual([expect.objectContaining({ intent: 'byId', outcome: 'failed' })]);
    expectNoValue([answer.body, rig.appEvents, rig.modelEvents, rig.rows, rig.logs], ['SENTINEL_TEXT']);
    await rig.close();
  });

  it('shows that the route checks the extension\'s own folder and the gate its own: the same intent name runs the harmless text when the gate holds it', async () => {
    const rig = await forcedRig(FILE_QUERY, () => Promise.resolve({ status: 'rows' as const, rows: [] }));
    await rig.ask('Find it', reply('byId', { id: 'W-001' }));
    expect(rig.reads().map((read) => read.cypher)).toEqual([FILE_QUERY]);
    await rig.close();
  });
});

describe('a result of a type the mapping does not name is refused whole', () => {
  const node = (labels: readonly string[], properties: Record<string, unknown>) => ({ $type: 'node', elementId: 'n1', labels, properties });
  const rowsOf = (value: unknown) => () => Promise.resolve({ status: 'rows' as const, rows: [{ n: value }] });

  const UNMAPPED_RESULTS = [
    ['a scalar', 'SENTINEL_SCALAR'],
    ['a node of a type the mapping does not name', node(['Stranger'], { secret: 'SENTINEL_UNMAPPED' })],
    ['a forged $type map', { $type: 'unsupported', secret: 'SENTINEL_FORGED' }],
    ['a list that holds a scalar', [node(['Widget'], { widgetId: 'W-001' }), 'SENTINEL_LIST']],
  ] as const;

  it.each(UNMAPPED_RESULTS)('refuses %s as file-query-result, draws nothing, summarizes nothing and records no value of it', async (_name, value) => {
    const store = recordingRunStore();
    const extension = createEnterpriseExtension({ modelBaseUrl: stub.baseUrl, runStore: store.factory });
    const rig = await startRig({ extension, stub, rows: store.rows, folder: folderOf(), respond: rowsOf(value) });
    const answer = await rig.ask('Find it', reply('byId', { id: 'W-001' }));
    expect(answer.body).toMatchObject({ error: { code: 'INVALID_REQUEST', details: { reason: 'file-query-result' } } });
    expect(answer.body['answered']).toBeUndefined();
    expect(rig.rows).toEqual([expect.objectContaining({ outcome: 'failed' })]);
    expectNoValue([answer.body, rig.appEvents, rig.modelEvents, rig.rows, rig.logs], ['SENTINEL_SCALAR', 'SENTINEL_UNMAPPED', 'SENTINEL_FORGED', 'SENTINEL_LIST']);
    await rig.close();
  });
});
