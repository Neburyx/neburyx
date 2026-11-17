import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { AppError } from '../errors.js';
import { assembleGate } from '../gate/assemble.js';
import type { SourceGate, SourceGateOptions } from '../gate/source-gate.js';
import { schemaDraftConstraintsTemplate, schemaDraftIndexesTemplate, schemaDraftTokensTemplate } from '../gate/templates/schema-draft.js';
import { parseMapping } from '../mapping/load.js';
import { createNeo4jExecutor } from '../sources/executor.js';
import { FAILURE_SENTENCES } from '../source-test/reasons.js';
import { expectNoForbiddenCalls, fakeDrivers, neo4jError, type FakeBehaviour } from '../testing/fake-source-driver.js';
import { INIT_USAGE, parseInitArgs } from '../commands.js';
import { runInitCommand } from './command.js';

const USER = 'distinct-user-9c1f';
const PASSWORD = 'distinct-pass-4b7e';
const ENV = { NEO4J_USERNAME: USER, NEO4J_PASSWORD: PASSWORD };
const BASE = ['--source', 'own-source', '--uri', 'bolt://db.example:7687'];

const TOKENS = { labels: ['Person', 'Place'], labelsCut: false, types: ['LINKS_TO'], typesCut: false, propertyKeys: ['ref', 'name', 'planted'], propertyKeysCut: false };
const INDEXES = { indexes: [{ name: 'person_ref', type: 'RANGE', entityType: 'NODE', labelsOrTypes: ['Person'], properties: ['ref'], state: 'ONLINE' }], truncated: false };
const CONSTRAINTS = { constraints: [{ name: 'person_ref_unique', type: 'UNIQUENESS', entityType: 'NODE', labelsOrTypes: ['Person'], properties: ['ref'] }], truncated: false };
const SCHEMA_BEHAVIOUR: FakeBehaviour = { schemaTokens: [TOKENS], schemaIndexes: [INDEXES], rows: [CONSTRAINTS] };

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

async function run(args: readonly string[], behaviour: FakeBehaviour = SCHEMA_BEHAVIOUR, env: Record<string, string | undefined> = ENV) {
  const fake = fakeDrivers(behaviour);
  const out: string[] = [];
  const err: string[] = [];
  const logs: string[] = [];
  const code = await runInitCommand(args, env, {
    stdout: { write: (text) => out.push(text) },
    stderr: { write: (text) => err.push(text) },
    logger: { warn: (fields, message) => logs.push(JSON.stringify({ fields, message })) },
    openSourceGate: (options: SourceGateOptions): SourceGate => {
      const executor = createNeo4jExecutor({ sources: options.mapping.sources, env: options.env, logger: options.logger, createDriver: fake.factory });
      const parts = assembleGate({ mapping: options.mapping, seams: options.seams, executor, logger: options.logger });
      return { gate: parts.gate, system: parts.system, indexes: parts.indexes, catalog: parts.catalog, close: () => executor.close() };
    },
  });
  return { code, fake, stdout: out.join(''), stderr: err.join(''), logs: logs.join('\n') };
}

describe('the arguments of init', () => {
  it('takes the flags in any order, each once', () => {
    expect(parseInitArgs(['--uri', 'u', '--source', 's'])).toEqual({ source: 's', uri: 'u' });
    expect(parseInitArgs([...BASE, '--database', 'd', '--username-env', 'U', '--password-env', 'P', '--connect-wait-ms', '3000', '--out', 'f.yaml'])).toEqual({ source: 'own-source', uri: 'bolt://db.example:7687', database: 'd', usernameEnv: 'U', passwordEnv: 'P', connectWaitMs: '3000', out: 'f.yaml' });
  });

  it.each([[[]], [['--source', 's']], [['--uri', 'u']], [[...BASE, '--unknown', 'x']], [[...BASE, '--source', 'again']], [[...BASE, '--out']], [[...BASE, 'extra']], [['--source', '--uri', 'u']]])('refuses %j', (args) => {
    expect(parseInitArgs(args)).toBeUndefined();
  });
});

describe('neburyx init', () => {
  it('prints the draft, says how many places to fill in, and exits 0', async () => {
    const { code, stdout, stderr } = await run(BASE);
    expect(code).toBe(0);
    const document = parse(stdout) as { sources: { id: string; uri: string; database: string; auth: Record<string, string>; entities: { type: string }[]; relationships: { type: string }[] }[] };
    expect(document.sources[0]).toMatchObject({ id: 'own-source', uri: 'bolt://db.example:7687', database: 'neo4j', auth: { kind: 'basic', username_env: 'NEO4J_USERNAME', password_env: 'NEO4J_PASSWORD' } });
    expect(document.sources[0]?.entities.map((entity) => entity.type)).toEqual(['Person', 'Place']);
    expect(stderr).toContain('The draft holds 9 places to fill in');
    expect(stderr).not.toContain('more than the bound');
  });

  it('says on standard error that a kind was cut, with no count', async () => {
    const { code, stdout, stderr } = await run(BASE, { ...SCHEMA_BEHAVIOUR, schemaTokens: [{ ...TOKENS, labelsCut: true }] });
    expect(code).toBe(0);
    expect(stdout).toContain('# NOTE: the database has more than 500 labels');
    expect(stderr).toContain('more than the bound of labels');
  });

  it('puts the database and the two environment variable names of the flags in the draft', async () => {
    const { code, stdout } = await run([...BASE, '--database', 'graph2', '--username-env', 'MY_USER', '--password-env', 'MY_PASS'], SCHEMA_BEHAVIOUR, { MY_USER: USER, MY_PASS: PASSWORD });
    expect(code).toBe(0);
    expect(stdout).toContain('database: "graph2"');
    expect(stdout).toContain('username_env: MY_USER');
    expect(stdout).toContain('password_env: MY_PASS');
  });

  it('gives the first connection a wait of its own, 8,000 ms unless the flag says otherwise, apart from the 2,000 ms queue wait of the mapping defaults', async () => {
    const standard = await run(BASE);
    expect(standard.fake.drivers[0]?.settings.connectionAcquisitionTimeout).toBe(8000);
    expect(standard.fake.drivers[0]?.settings.connectionTimeout).toBe(8000);
    const chosen = await run([...BASE, '--connect-wait-ms', '3000']);
    expect(chosen.code).toBe(0);
    expect(chosen.fake.drivers[0]?.settings.connectionAcquisitionTimeout).toBe(3000);
    expect(chosen.fake.drivers[0]?.settings.connectionTimeout).toBe(3000);
    const edges = await Promise.all([1000, 9000].map((ms) => run([...BASE, '--connect-wait-ms', String(ms)])));
    expect(edges.map((edge) => edge.code)).toEqual([0, 0]);
  });

  it('writes neither the user name nor the password anywhere: not in the draft, the messages or the logs', async () => {
    const ok = await run(BASE);
    const down = await run(BASE, { beginError: neo4jError('ServiceUnavailable') });
    for (const result of [ok, down]) for (const text of [result.stdout, result.stderr, result.logs]) {
      expect(text).not.toContain(USER);
      expect(text).not.toContain(PASSWORD);
    }
  });

  it('writes the draft to the file and nothing to standard output, and refuses a file that exists', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'init-out-'));
    folders.push(folder);
    const file = join(folder, 'draft.yaml');
    const written = await run([...BASE, '--out', file]);
    expect(written.code).toBe(0);
    expect(written.stdout).toBe('');
    expect(readFileSync(file, 'utf8')).toContain('stable_id: TODO');
    const again = await run([...BASE, '--out', file]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('exists');
    expect(again.fake.drivers).toHaveLength(0);
    writeFileSync(join(folder, 'other.yaml'), 'keep');
    const other = await run([...BASE, '--out', join(folder, 'other.yaml')]);
    expect(other.code).toBe(1);
    expect(readFileSync(join(folder, 'other.yaml'), 'utf8')).toBe('keep');
  });

  it.each([
    ['no arguments', []],
    ['a missing uri', ['--source', 'own-source']],
    ['an unknown flag', [...BASE, '--x', 'y']],
    ['a source id the mapping format refuses', ['--source', 'has space', '--uri', 'bolt://db.example:7687']],
    ['a reserved source id', ['--source', 'v1', '--uri', 'bolt://db.example:7687']],
    ['an address the mapping format refuses', ['--source', 'own-source', '--uri', 'http://db.example']],
    ['an address with no host', ['--source', 'own-source', '--uri', 'bolt://']],
    ['an environment variable name that is not one', [...BASE, '--username-env', '1 bad']],
    ['a connect wait that is not a number', [...BASE, '--connect-wait-ms', 'soon']],
    ['a connect wait below the least', [...BASE, '--connect-wait-ms', '999']],
    ['a connect wait above the most', [...BASE, '--connect-wait-ms', '9001']],
    ['a connect wait that is not whole', [...BASE, '--connect-wait-ms', '2500.5']],
  ])('prints the usage, exits 2 and reads nothing for %s', async (_name, args) => {
    const { code, stderr, fake } = await run(args);
    expect(code).toBe(2);
    expect(stderr).toContain(INIT_USAGE);
    expect(fake.drivers).toHaveLength(0);
  });

  it.each([
    ['unreachable', { beginError: neo4jError('ServiceUnavailable') }, FAILURE_SENTENCES.unreachable],
    ['a refused sign-in', { beginError: neo4jError('Neo.ClientError.Security.Unauthorized') }, FAILURE_SENTENCES.authentication],
    ['a refused read', { ...SCHEMA_BEHAVIOUR, schemaError: { read: 'indexes', error: neo4jError('Neo.ClientError.Security.Forbidden') } }, FAILURE_SENTENCES.refused],
  ] as const)('says %s in the sentence test-source uses, exits 1 and writes no file', async (_name, behaviour, sentence) => {
    const folder = mkdtempSync(join(tmpdir(), 'init-out-'));
    folders.push(folder);
    const file = join(folder, 'draft.yaml');
    const result = await run([...BASE, '--out', file], behaviour);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(sentence);
    expect(result.stdout).toBe('');
    expect(() => readFileSync(file)).toThrow();
  });

  it('says which read could not be used, with the reason and no value, when the server fails a read', async () => {
    const result = await run(BASE, { beginError: Object.assign(new Error('a message with a value: ' + PASSWORD), { code: 'Neo.TransientError.General.OutOfMemoryError' }) });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/The source's answer to the read schema-draft-tokens could not be used( \([\w-]+\))?\./);
    expect(result.stderr).not.toContain(PASSWORD);
  });

  it('names the code of a failure that says nothing about the source, and no value', async () => {
    const err: string[] = [];
    const code = await runInitCommand(BASE, ENV, {
      stdout: { write: () => undefined },
      stderr: { write: (text) => err.push(text) },
      openSourceGate: () => ({ gate: undefined as never, system: { run: () => Promise.reject(new AppError('SOURCE_BUSY')) }, indexes: undefined as never, catalog: undefined as never, close: () => Promise.resolve() }),
    });
    expect(code).toBe(1);
    expect(err.join('')).toBe('The source could not be read (SOURCE_BUSY); try again.\n');
  });

  it('says that the credentials are not set when the variables are not', async () => {
    const result = await run(BASE, SCHEMA_BEHAVIOUR, {});
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(FAILURE_SENTENCES.credentials);
  });

  it('says that a database with no labels has nothing to draft from, writes nothing and exits 1', async () => {
    const result = await run(BASE, { ...SCHEMA_BEHAVIOUR, schemaTokens: [{ ...TOKENS, labels: [] }] });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('no labels to draft from');
    expect(result.stdout).toBe('');
  });

  it('sends the source only the three fixed read templates, in read-only sessions, and no write, commit or other statement', async () => {
    const { fake, code } = await run(BASE);
    expect(code).toBe(0);
    expectNoForbiddenCalls(fake);
    const sessions = fake.drivers.flatMap((driver) => driver.sessions);
    expect(sessions.length).toBeGreaterThan(0);
    for (const session of sessions) expect(session.config.defaultAccessMode).toBe('READ');
    const statements = sessions.flatMap((session) => session.queries.map((query) => query.cypher));
    expect(statements).toEqual([schemaDraftTokensTemplate.cypher, schemaDraftIndexesTemplate.cypher, schemaDraftConstraintsTemplate.cypher]);
    for (const session of sessions) expect(session.rollbackCalls).toBe(session.begins.length);
  });

  it('writes a draft that the mapping loader accepts once the markers are replaced', async () => {
    const { stdout } = await run(BASE);
    const filled = stdout.replaceAll('stable_id: TODO', 'stable_id: ref').replaceAll('from: TODO', 'from: Person').replaceAll('to: TODO', 'to: Place');
    expect(parseMapping(filled, 'draft.yaml').sources[0]?.id).toBe('own-source');
  });
});
