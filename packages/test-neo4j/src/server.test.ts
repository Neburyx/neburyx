import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeState {
  databases: Set<string>;
  users: Set<string>;
  roles: Set<string>;
  log: string[];
  failOn: RegExp | undefined;
  failOnce: boolean;
  driverThrows: boolean;
  edition: string;
  hold: Promise<void> | undefined;
  failAfterCreate: RegExp | undefined;
  existsFailsFrom: number | undefined;
  existsChecks: number;
  holdOn: RegExp;
  duplicateAsGeneric: boolean;
  sessionCloseFails: boolean;
  driverCloseFails: boolean;
  afterExistsCheck: ((name: string) => void) | undefined;
}

const state: FakeState = { databases: new Set(), users: new Set(), roles: new Set(), log: [], failOn: undefined, failOnce: false, driverThrows: false, edition: 'enterprise', hold: undefined, failAfterCreate: undefined, existsFailsFrom: undefined, existsChecks: 0, holdOn: /^CREATE DATABASE/, duplicateAsGeneric: false, sessionCloseFails: false, driverCloseFails: false, afterExistsCheck: undefined };

class AlreadyExists extends Error {
  readonly code = 'Neo.ClientError.Statement.ArgumentError';
  constructor() {
    super('Failed to create the specified database: it already exists, at secret-host.example.test');
  }
}

class ServerFailure extends Error {
  readonly code = 'Neo.ClientError.Test.Failure';
  constructor() {
    super('connection to secret-host.example.test:7687 refused for secret-user with secret-password');
  }
}

async function runStatement(database: string, cypher: string, parameters: Record<string, unknown>): Promise<{ records: { get: (key: string) => unknown }[] }> {
  state.log.push(cypher);
  if (state.hold !== undefined && state.holdOn.test(cypher)) await state.hold;
  if (state.failOn?.test(cypher) === true) {
    if (state.failOnce) state.failOn = undefined;
    throw new ServerFailure();
  }
  const rows = (...values: Record<string, unknown>[]) => ({ records: values.map((value) => ({ get: (key: string) => value[key] })) });
  const quoted = /`([^`]*(?:``[^`]*)*)`/.exec(cypher)?.[1]?.replaceAll('``', '`') ?? '';
  const sets: Record<string, Set<string>> = { DATABASE: state.databases, USER: state.users, ROLE: state.roles };
  const kind = /(DATABASE|USER|ROLE)/.exec(cypher)?.[1] ?? '';
  if (/^CALL dbms.components/.test(cypher)) return rows({ version: '5.26.32', edition: state.edition });
  if (/^SHOW DATABASES YIELD name RETURN/.test(cypher)) return rows(...[...state.databases].map((name) => ({ name })));
  if (/^SHOW USERS YIELD user RETURN/.test(cypher)) return rows(...[...state.users].map((user) => ({ user })));
  if (/^SHOW ROLES YIELD role RETURN/.test(cypher)) return rows(...[...state.roles].map((role) => ({ role })));
  const exists = /^SHOW (DATABASES|USERS|ROLES) YIELD \w+ WHERE \w+ = \$name RETURN count/.exec(cypher);
  if (exists !== null) {
    state.existsChecks += 1;
    if (state.existsFailsFrom !== undefined && state.existsChecks >= state.existsFailsFrom) throw new ServerFailure();
    const set = sets[(exists[1] ?? '').replace(/S$/, '')];
    const found = set?.has(String(parameters['name'])) === true ? 1 : 0;
    const after = state.afterExistsCheck;
    state.afterExistsCheck = undefined;
    after?.(String(parameters['name']));
    return rows({ found });
  }
  if (/^CREATE (DATABASE|USER|ROLE)/.test(cypher)) {
    if (sets[kind]?.has(quoted) === true) throw state.duplicateAsGeneric ? new ServerFailure() : new AlreadyExists();
    sets[kind]?.add(quoted);
    if (state.failAfterCreate?.test(cypher) === true) throw new ServerFailure();
    return rows();
  }
  if (/^DROP (DATABASE|USER|ROLE)/.test(cypher)) {
    sets[kind]?.delete(quoted);
    return rows();
  }
  if (/^ALTER DATABASE/.test(cypher)) return rows();
  if (/^RETURN 1/.test(cypher)) {
    if (!state.databases.has(database)) throw new ServerFailure();
    return rows({ 1: 1 });
  }
  return rows();
}

vi.mock('neo4j-driver', () => {
  const driver = () => {
    if (state.driverThrows) throw new Error('Invalid URI bolt://secret-host.example.test:7687 for secret-user');
    return {
      verifyConnectivity: async () => undefined,
      session: ({ database }: { database: string }) => ({ run: async (cypher: string, parameters: Record<string, unknown> = {}) => runStatement(database, cypher, parameters), close: async () => { if (state.sessionCloseFails) throw new ServerFailure(); } }),
      close: async () => { if (state.driverCloseFails) throw new ServerFailure(); },
    };
  };
  return { default: { driver, auth: { basic: () => ({}) } } };
});

const { startDevNeo4j, sweepLeftovers } = await import('./server.js');
const { namesFor } = await import('./names.js');
const { stopAllStarted } = await import('./registry.js');
const { DevNeo4jNotConfigured } = await import('./settings.js');

const SETTINGS = { uri: 'bolt://secret-host.example.test:7687', user: 'secret-user', password: 'secret-password' };
const NOW = Date.now();
const OLD = NOW - 5 * 60 * 60 * 1000;

beforeEach(() => {
  state.databases = new Set(['neo4j', 'system', 'imdb', 'nbxprivcheck']);
  state.users = new Set(['neo4j', 'secret-user']);
  state.roles = new Set(['admin', 'reader', 'PUBLIC']);
  state.log = [];
  state.failOn = undefined;
  state.failOnce = false;
  state.driverThrows = false;
  state.edition = 'enterprise';
  state.hold = undefined;
  state.afterExistsCheck = undefined;
  state.failAfterCreate = undefined;
  state.existsFailsFrom = undefined;
  state.existsChecks = 0;
  state.holdOn = /^CREATE DATABASE/;
  state.duplicateAsGeneric = false;
  state.sessionCloseFails = false;
  state.driverCloseFails = false;
});
afterEach(async () => {
  await stopAllStarted().catch(() => undefined);
});

const FOREIGN = ['neo4j', 'system', 'imdb', 'nbxprivcheck'];

describe('a run on the dev server', () => {
  it('makes a database of its own, creates and drops its logins and roles, and leaves everything else as it was', async () => {
    const server = await startDevNeo4j(SETTINGS);
    expect(server.database).toMatch(/^nbx-test-/);
    expect(state.databases.has(server.database)).toBe(true);
    const reader = await server.createLogin('reader');
    const writer = await server.createLogin('writer');
    expect(reader.user).toMatch(/^nbx_test_.*_reader$/);
    expect(writer.user).toMatch(/^nbx_test_.*_writer$/);
    expect(state.users.has(reader.user) && state.users.has(writer.user)).toBe(true);
    await server.setReadOnly();
    await server.stop();
    expect([...state.databases].sort()).toEqual([...FOREIGN].sort());
    expect([...state.users].sort()).toEqual(['neo4j', 'secret-user']);
    expect([...state.roles].sort()).toEqual(['PUBLIC', 'admin', 'reader']);
    expect(state.log.filter((statement) => /^(DROP|ALTER|CREATE)/.test(statement)).every((statement) => /nbx[-_]test[-_]/.test(statement))).toBe(true);
  });

  it('sweeps only databases, logins and roles named exactly as a run names them and made more than three hours ago', async () => {
    const old = namesFor(OLD);
    const recent = namesFor(NOW - 60_000);
    const decoys = ['nbx-test-', 'nbx-test-abc', `my-${old.database}`, `${old.database}-extra`];
    for (const name of [old.database, recent.database, ...decoys]) state.databases.add(name);
    for (const name of [old.login('reader'), recent.login('writer'), 'nbx_test_', 'nbx_test_alice', `x${old.login('reader')}`]) state.users.add(name);
    for (const name of [old.role('writer'), recent.role('reader'), 'nbx_test_role_of_someone']) state.roles.add(name);
    const dropped = await sweepLeftovers({ session: ({ database }: { database: string }) => ({ run: async (cypher: string, parameters: Record<string, unknown> = {}) => runStatement(database, cypher, parameters), close: async () => undefined, beginTransaction: async () => ({ run: async () => { throw new ServerFailure(); }, commit: async () => undefined, rollback: async () => undefined, close: async () => undefined }) }) } as never, NOW);
    expect(dropped.databases).toEqual([old.database]);
    expect([...dropped.objects].sort()).toEqual([old.login('reader'), old.role('writer')].sort());
    for (const name of [recent.database, ...decoys, ...FOREIGN]) expect(state.databases.has(name)).toBe(true);
    for (const name of [recent.login('writer'), 'nbx_test_', 'nbx_test_alice', 'secret-user']) expect(state.users.has(name)).toBe(true);
    expect(state.roles.has('nbx_test_role_of_someone') && state.roles.has(recent.role('reader'))).toBe(true);
  });

  it('does not drop a database it did not make when the name is taken before the run looks', async () => {
    const taken = namesFor();
    vi.resetModules();
    vi.doMock('./names.js', async (original) => ({ ...(await original<typeof import('./names.js')>()), namesFor: () => taken }));
    const { startDevNeo4j: startAgain } = await import('./server.js');
    state.databases.add(taken.database);
    await expect(startAgain(SETTINGS)).rejects.toThrow(/could not create a database/);
    expect(state.databases.has(taken.database)).toBe(true);
    expect(state.log.some((statement) => statement.startsWith('DROP DATABASE') && statement.includes(taken.database))).toBe(false);
    vi.doUnmock('./names.js');
  });

  it('does not drop a database that someone else made between the look and the create, when the create says it exists', async () => {
    const taken = namesFor();
    vi.resetModules();
    vi.doMock('./names.js', async (original) => ({ ...(await original<typeof import('./names.js')>()), namesFor: () => taken }));
    const { startDevNeo4j: startAgain } = await import('./server.js');
    state.afterExistsCheck = (name) => void state.databases.add(name);
    await expect(startAgain(SETTINGS)).rejects.toThrow(/could not create a database/);
    expect(state.databases.has(taken.database)).toBe(true);
    expect(state.log.some((statement) => statement.startsWith('DROP DATABASE') && statement.includes(taken.database))).toBe(false);
    vi.doUnmock('./names.js');
  });

  it('does not drop on a guess what a failed create may have made: it stays for the sweep, and the error says so', async () => {
    state.failAfterCreate = /^CREATE DATABASE/;
    const error: unknown = await startDevNeo4j(SETTINGS).catch((caught: unknown) => caught);
    expect(String((error as Error).message)).toMatch(/the next sweep drops it/);
    expect([...state.databases].filter((name) => name.startsWith('nbx-test-'))).toHaveLength(1);
    expect(state.log.some((statement) => statement.startsWith('DROP DATABASE `nbx-test-'))).toBe(false);
  });

  it('does not make a foreign database its own when the create answer is lost after someone else made it', async () => {
    const taken = namesFor();
    vi.resetModules();
    vi.doMock('./names.js', async (original) => ({ ...(await original<typeof import('./names.js')>()), namesFor: () => taken }));
    const { startDevNeo4j: startAgain } = await import('./server.js');
    state.afterExistsCheck = (name) => void state.databases.add(name);
    state.duplicateAsGeneric = true;
    await expect(startAgain(SETTINGS)).rejects.toThrow(/could not create a database/);
    expect(state.databases.has(taken.database)).toBe(true);
    expect(state.log.some((statement) => statement.startsWith('DROP DATABASE') && statement.includes(taken.database))).toBe(false);
    vi.doUnmock('./names.js');
  });

  it('drops nothing when the create failed and made nothing', async () => {
    state.failOn = /^CREATE DATABASE/;
    await expect(startDevNeo4j(SETTINGS)).rejects.toThrow(/could not create a database/);
    expect(state.log.some((statement) => statement.startsWith('DROP DATABASE `nbx-test-'))).toBe(false);
  });

  it('does not wait for nothing: a stop that comes while a create is pending waits for it and drops what it made', async () => {
    let release: () => void = () => undefined;
    state.hold = new Promise<void>((resolve) => void (release = resolve));
    const started = startDevNeo4j(SETTINGS).catch(() => undefined);
    await vi.waitFor(() => expect(state.log.some((statement) => statement.startsWith('CREATE DATABASE'))).toBe(true));
    const stopping = stopAllStarted();
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await stopping;
    await started;
    expect([...state.databases].filter((name) => name.startsWith('nbx-test-'))).toEqual([]);
  });

  it('drops the user of a login whose creation a stop interrupted between its role and its user, and starts nothing after it', async () => {
    const server = await startDevNeo4j(SETTINGS);
    let release: () => void = () => undefined;
    state.hold = new Promise<void>((resolve) => void (release = resolve));
    state.holdOn = /^CREATE USER/;
    const login = server.createLogin('writer').catch((error: unknown) => error);
    await vi.waitFor(() => expect(state.log.some((statement) => statement.startsWith('CREATE USER'))).toBe(true));
    const stopping = server.stop();
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await stopping;
    await login;
    expect([...state.users].filter((name) => name.startsWith('nbx_test_'))).toEqual([]);
    expect([...state.roles].filter((name) => name.startsWith('nbx_test_'))).toEqual([]);
    expect([...state.databases].filter((name) => name.startsWith('nbx-test-'))).toEqual([]);
    await expect(server.createLogin('reader')).rejects.toThrow(/stopping/);
  });

  it('starts no creation after a stop began, and a creation under way is finished and then dropped', async () => {
    const server = await startDevNeo4j(SETTINGS);
    let release: () => void = () => undefined;
    state.hold = new Promise<void>((resolve) => void (release = resolve));
    state.holdOn = /^CREATE ROLE/;
    const first = server.createLogin('reader').catch((error: unknown) => error);
    await vi.waitFor(() => expect(state.log.some((statement) => statement.startsWith('CREATE ROLE'))).toBe(true));
    const stopping = server.stop();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(server.createLogin('writer')).rejects.toThrow(/stopping/);
    release();
    await stopping;
    await first;
    expect([...state.roles].filter((name) => name.startsWith('nbx_test_'))).toEqual([]);
    expect([...state.users].filter((name) => name.startsWith('nbx_test_'))).toEqual([]);
    expect([...state.databases].filter((name) => name.startsWith('nbx-test-'))).toEqual([]);
  });

  it('serialises stops that overlap, so that a failed drop stays owned and a retry drops it', async () => {
    const server = await startDevNeo4j(SETTINGS);
    await server.createLogin('reader');
    state.failOn = /^DROP ROLE/;
    const results = await Promise.allSettled([server.stop(), server.stop()]);
    expect(results.some((result) => result.status === 'rejected')).toBe(true);
    expect([...state.roles].filter((name) => name.startsWith('nbx_test_'))).toHaveLength(1);
    state.failOn = undefined;
    await server.stop();
    expect([...state.roles].filter((name) => name.startsWith('nbx_test_'))).toEqual([]);
    expect([...state.databases].filter((name) => name.startsWith('nbx-test-'))).toEqual([]);
  });

  it('keeps the cleanup failures of the check of the server beside the error that made it fail', async () => {
    const { checkDevServer } = await import('./server.js');
    state.failOn = /^CALL dbms.components/;
    state.sessionCloseFails = true;
    state.driverCloseFails = true;
    const error: unknown = await checkDevServer(SETTINGS).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toHaveLength(3);
    state.failOn = undefined;
    state.sessionCloseFails = false;
    state.driverCloseFails = false;
  });

  it('reports a session that did not close, at the next stop, and a driver that did not close from the check of the server', async () => {
    const { checkDevServer } = await import('./server.js');
    state.sessionCloseFails = true;
    await expect(checkDevServer(SETTINGS)).rejects.toThrow(AggregateError);
    state.sessionCloseFails = false;
    state.driverCloseFails = true;
    await expect(checkDevServer(SETTINGS)).rejects.toThrow(AggregateError);
    state.driverCloseFails = false;
    const server = await startDevNeo4j(SETTINGS);
    state.sessionCloseFails = true;
    await server.createLogin('reader');
    state.sessionCloseFails = false;
    await expect(server.stop()).rejects.toThrow(AggregateError);
    await server.stop();
    expect([...state.databases].filter((name) => name.startsWith('nbx-test-'))).toEqual([]);
  });

  it('drops a login, a role or a database that a failed creation left behind', async () => {
    const server = await startDevNeo4j(SETTINGS);
    state.failOn = /^GRANT SHOW INDEX/;
    await expect(server.createLogin('reader')).rejects.toThrow(/GRANT SHOW INDEX/);
    const left = [...state.roles].filter((name) => name.startsWith('nbx_test_'));
    expect(left).toHaveLength(1);
    state.failOn = undefined;
    await server.stop();
    expect([...state.roles].filter((name) => name.startsWith('nbx_test_'))).toEqual([]);
    expect([...state.databases].filter((name) => name.startsWith('nbx-test-'))).toEqual([]);
  });

  it('puts the server code and nothing else in the errors that leave it: no address, no name, no password', async () => {
    const messages: string[] = [];
    const collect = async (work: () => Promise<unknown>): Promise<void> => {
      try {
        await work();
      } catch (error) {
        const found = error instanceof AggregateError ? [...error.errors, error] : [error];
        for (const entry of found) messages.push(String(entry instanceof Error ? `${entry.message} ${entry.stack ?? ''}` : entry));
      }
    };
    state.driverThrows = true;
    await collect(() => startDevNeo4j(SETTINGS));
    state.driverThrows = false;
    state.failOn = /^CALL dbms.components/;
    await collect(() => startDevNeo4j(SETTINGS));
    state.failOn = /^CREATE DATABASE/;
    await collect(() => startDevNeo4j(SETTINGS));
    state.failOn = undefined;
    const server = await startDevNeo4j(SETTINGS);
    state.failOn = /^CREATE USER/;
    await collect(() => server.createLogin('writer'));
    state.failOn = /^ALTER DATABASE/;
    await collect(() => server.setReadOnly());
    state.failOn = /^DROP DATABASE/;
    await collect(() => server.stop());
    expect(messages.length).toBeGreaterThanOrEqual(6);
    for (const message of messages) {
      expect(message).not.toContain('secret-host');
      expect(message).not.toContain('secret-user');
      expect(message).not.toContain('secret-password');
    }
    expect(messages.some((message) => message.includes('Neo.ClientError.Test.Failure'))).toBe(true);
    state.failOn = undefined;
    await server.stop();
  });

  it('tries a step that failed again at the next stop, and does not repeat the ones that succeeded', async () => {
    const server = await startDevNeo4j(SETTINGS);
    await server.createLogin('reader');
    state.failOn = /^DROP ROLE/;
    await expect(server.stop()).rejects.toThrow(AggregateError);
    expect([...state.users].filter((name) => name.startsWith('nbx_test_'))).toEqual([]);
    expect([...state.roles].filter((name) => name.startsWith('nbx_test_'))).toHaveLength(1);
    state.failOn = undefined;
    state.log = [];
    await server.stop();
    expect(state.log.filter((statement) => statement.startsWith('DROP USER'))).toEqual([]);
    expect([...state.roles].filter((name) => name.startsWith('nbx_test_'))).toEqual([]);
    expect([...state.databases].filter((name) => name.startsWith('nbx-test-'))).toEqual([]);
  });

  it('refuses a login of its own prefix and an address that is not bolt, whoever gives the settings, and a server that is not Enterprise', async () => {
    await expect(startDevNeo4j({ ...SETTINGS, user: 'nbx_test_x_reader' })).rejects.toThrow(/starts with nbx_test_/);
    await expect(startDevNeo4j({ ...SETTINGS, uri: 'http://secret-host.example.test' })).rejects.toThrow(/not a bolt or neo4j address/);
    state.edition = 'community';
    await expect(startDevNeo4j(SETTINGS)).rejects.toThrow(/not an Enterprise edition/);
    expect([...state.databases].filter((name) => name.startsWith('nbx-test-'))).toEqual([]);
  });

  it('stops what a hook started when another of its starts failed, through the registry', async () => {
    state.failOn = /^CREATE DATABASE/;
    state.failOnce = true;
    const settled = await Promise.allSettled([startDevNeo4j(SETTINGS), startDevNeo4j(SETTINGS)]);
    expect(settled.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect([...state.databases].filter((name) => name.startsWith('nbx-test-'))).toHaveLength(1);
    await stopAllStarted();
    expect([...state.databases].filter((name) => name.startsWith('nbx-test-'))).toEqual([]);
  });

  it('keeps only a server code of the shape of one: a code a driver took from an address is dropped', async () => {
    const { failure } = await import('./errors.js');
    expect(failure('x', Object.assign(new Error('m'), { code: 'Neo.ClientError.Security.Forbidden' })).message).toBe('x (Neo.ClientError.Security.Forbidden)');
    expect(failure('x', Object.assign(new Error('m'), { code: 'ECONNREFUSED secret-host.example.test:7687' })).message).toBe('x (unknown)');
  });

  it('fails loudly with the names of the variables, no value, when the connection is not given', () => {
    expect(new DevNeo4jNotConfigured(['NBX_EE_URI'], '/f').message).toContain('NBX_EE_URI');
  });
});
