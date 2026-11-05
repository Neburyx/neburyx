import { randomUUID } from 'node:crypto';
import neo4j, { type Driver, type QueryResult } from 'neo4j-driver';
import { guardedDriver, type AdminDriver } from './admin.js';
import { failure, type StartFailure } from './errors.js';
import { isStaleDatabase, isStaleObject, isTestDatabase, namesFor, type LoginKind, type RunNames } from './names.js';
import { registerOpen } from './registry.js';
import { assertDevSettings, devSettings, fastSettings, type DevSettings } from './settings.js';

const ONLINE_LIMIT_MS = 120_000;

export interface Login {
  readonly user: string;
  readonly password: string;
}

/** The dev server, with one database of its own that this run made and will drop. */
export interface DevNeo4j {
  /** `neo4j:` and the exact version of the server, as the tests that compare a version want it. */
  readonly image: string;
  readonly version: string;
  readonly boltUri: string;
  /** The dev login: the one the environment gives. It can create what the run needs; what writes uses it. */
  readonly user: string;
  readonly password: string;
  /** The database this run made; every test of the run reads and writes only here. */
  readonly database: string;
  /** The admin connection of the run: sessions on the dev login, whose errors carry the server's code and nothing else. */
  readonly admin: AdminDriver;
  /** A login of this run that can only read `database`, or one that can also write and create names there; dropped with the run. */
  createLogin(kind: LoginKind): Promise<Login>;
  /** Makes `database` refuse writes, for a test of a source that cannot be written to. */
  setReadOnly(): Promise<void>;
  /** Drops what this run made. Safe to repeat: a step that failed is tried again, and what was dropped is not. */
  stop(): Promise<void>;
}

const quote = (name: string): string => `\`${name.replaceAll('`', '``')}\``;

type Run = (cypher: string, parameters?: Record<string, unknown>) => Promise<QueryResult>;

/** One session on the system database; a statement that fails is reported by its first words and the server's code. */
async function inSystem<T>(admin: Driver, work: (run: Run) => Promise<T>, onCloseFailure: (error: Error) => void = () => undefined): Promise<T> {
  let session;
  try {
    session = admin.session({ database: 'system' });
  } catch (error) {
    throw failure('could not open a session on the dev Neo4j server', error);
  }
  try {
    return await work(async (cypher, parameters = {}) => {
      try {
        return await session.run(cypher, parameters);
      } catch (error) {
        throw failure(`the statement ${cypher.trim().split(/\s+/).slice(0, 3).join(' ')} failed`, error);
      }
    });
  } finally {
    await session.close().catch((error: unknown) => void onCloseFailure(failure('a session did not close', error)));
  }
}

function connect(settings: DevSettings): Driver {
  assertDevSettings(settings);
  try {
    return neo4j.driver(settings.uri, neo4j.auth.basic(settings.user, settings.password));
  } catch (error) {
    throw failure('could not open a driver for the dev Neo4j server', error);
  }
}

async function pollUntil(observe: () => Promise<boolean>, limitMs: number): Promise<boolean> {
  const until = Date.now() + limitMs;
  for (;;) {
    if (await observe()) return true;
    if (Date.now() >= until) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function versionOf(admin: Driver, onCloseFailure: (error: Error) => void): Promise<string> {
  try {
    await admin.verifyConnectivity();
  } catch (error) {
    throw failure('could not connect to the dev Neo4j server with the login in the environment', error);
  }
  const components = await inSystem(admin, (run) => run('CALL dbms.components() YIELD versions, edition RETURN versions[0] AS version, edition'), onCloseFailure);
  if (String(components.records[0]?.get('edition')) !== 'enterprise') throw new Error('the dev Neo4j server is not an Enterprise edition, which the tests need to have a database of their own');
  return String(components.records[0]?.get('version'));
}

/** Connects once and says which version the dev server runs; fails loudly, naming what is missing or wrong, so a run stops before any test starts. */
export async function checkDevServer(given: DevSettings = devSettings()): Promise<string> {
  const admin = connect(await fastSettings(given));
  const failures: unknown[] = [];
  let version: string | undefined;
  let primary: unknown;
  let failed = false;
  try {
    version = await versionOf(admin, (error) => void failures.push(error));
  } catch (error) {
    failed = true;
    primary = error;
  }
  await admin.close().catch((error: unknown) => void failures.push(failure('the driver did not close', error)));
  if (failed) {
    if (failures.length > 0) throw new AggregateError([primary, ...failures], 'the check failed, and so did its cleanup');
    throw primary;
  }
  if (failures.length > 0 || version === undefined) throw new AggregateError(failures, 'a cleanup step failed');
  return version;
}

/** Drops what an earlier run left: only databases, logins and roles named exactly as this module names them and made more than three hours ago. */
export async function sweepLeftovers(admin: Driver, now: number = Date.now(), onCloseFailure: (error: Error) => void = () => undefined): Promise<{ readonly databases: readonly string[]; readonly objects: readonly string[] }> {
  const dropped = { databases: [] as string[], objects: [] as string[] };
  await inSystem(admin, async (run) => {
    const databases = (await run('SHOW DATABASES YIELD name RETURN name')).records.map((record) => String(record.get('name')));
    for (const name of databases.filter((candidate) => isStaleDatabase(candidate, now))) {
      await run(`DROP DATABASE ${quote(name)} IF EXISTS WAIT`);
      dropped.databases.push(name);
    }
    const users = (await run('SHOW USERS YIELD user RETURN user')).records.map((record) => String(record.get('user')));
    for (const name of users.filter((candidate) => isStaleObject(candidate, now))) {
      await run(`DROP USER ${quote(name)} IF EXISTS`);
      dropped.objects.push(name);
    }
    const roles = (await run('SHOW ROLES YIELD role RETURN role')).records.map((record) => String(record.get('role')));
    for (const name of roles.filter((candidate) => isStaleObject(candidate, now))) {
      await run(`DROP ROLE ${quote(name)} IF EXISTS`);
      dropped.objects.push(name);
    }
  }, onCloseFailure);
  return dropped;
}

type Kind = 'database' | 'user' | 'role';
const EXISTS: Readonly<Record<Kind, string>> = {
  database: 'SHOW DATABASES YIELD name WHERE name = $name RETURN count(*) AS found',
  user: 'SHOW USERS YIELD user WHERE user = $name RETURN count(*) AS found',
  role: 'SHOW ROLES YIELD role WHERE role = $name RETURN count(*) AS found',
};
const DROP: Readonly<Record<Kind, (name: string) => string>> = {
  database: (name) => `DROP DATABASE ${quote(name)} IF EXISTS WAIT`,
  user: (name) => `DROP USER ${quote(name)} IF EXISTS`,
  role: (name) => `DROP ROLE ${quote(name)} IF EXISTS`,
};

/**
 * Connects to the dev server, sweeps the leftovers of earlier runs, and makes a database of its own for this run. Touches nothing else:
 * it drops only what it made itself (it checks that a name is free before it makes it, and counts it as its own only once it exists),
 * and never changes a setting of the server. Every error that leaves it carries the server's code and no address, name or password.
 */
export async function startDevNeo4j(given: DevSettings = devSettings()): Promise<DevNeo4j> {
  assertDevSettings(given);
  const settings = await fastSettings(given);
  const admin = connect(settings);
  const names: RunNames = namesFor();
  /** What this run made, in the order it can be dropped: logins, then roles, then the database. */
  const owned: { kind: Kind; name: string }[] = [];
  /** Creations under way: a stop waits for them to settle, so that one that completes after a stop began is still dropped. */
  const inflight = new Set<Promise<unknown>>();
  const closeFailures: Error[] = [];
  let driverOpen = true;
  let closing = false;
  const noteClose = (error: Error): void => void closeFailures.push(error);

  const track = <T>(work: Promise<T>): Promise<T> => {
    inflight.add(work);
    const done = (): void => void inflight.delete(work);
    work.then(done, done);
    return work;
  };

  /**
   * Makes an object: checks that the name is free, runs `first` (the CREATE), and counts the object as this run's only when that CREATE succeeded, so that what `rest`
   * adds to it and fails at is dropped too. A CREATE that fails never makes it this run's, whatever the server then holds: an object that may exist after an
   * answer was lost is not dropped on a guess, and the sweep drops it three hours on, which the error says.
   */
  const make = (kind: Kind, name: string, first: (run: Run) => Promise<unknown>, rest: (run: Run) => Promise<unknown> = async () => undefined): Promise<void> => {
    if (closing) return Promise.reject(new Error('the run is stopping; nothing more is made'));
    return track(
      inSystem(
        admin,
        async (run) => {
          const found = async (): Promise<boolean> => Number((await run(EXISTS[kind], { name })).records[0]?.get('found')) > 0;
          if (await found()) throw new Error(`a ${kind} named ${name} exists already; it is not touched`);
          try {
            await first(run);
          } catch (error) {
            const known = (error as Partial<StartFailure>).alreadyExists === true;
            throw Object.assign(new Error(`${(error as Error).message}${known ? '' : `; if a ${kind} named ${name} was made, it stays for the sweep`}`), { code: (error as Partial<StartFailure>).code, alreadyExists: known });
          }
          owned.push({ kind, name });
          await rest(run);
        },
        noteClose,
      ),
    );
  };

  const stopOnce = async (): Promise<void> => {
    closing = true;
    // everything under way settles first, and nothing new starts, so that nothing made after the drops began is left behind
    while (inflight.size > 0) await Promise.allSettled([...inflight]);
    const failures: unknown[] = [];
    if (driverOpen) {
      const order: Kind[] = ['user', 'role', 'database'];
      for (const kind of order) {
        for (const entry of owned.filter((candidate) => candidate.kind === kind)) {
          try {
            await inSystem(admin, (run) => run(DROP[kind](entry.name)), noteClose);
            const at = owned.indexOf(entry);
            if (at >= 0) owned.splice(at, 1);
          } catch (error) {
            failures.push(error);
          }
        }
      }
      // the driver stays open while something is left to drop or it did not close, so that a second stop can try again
      if (failures.length === 0) {
        try {
          await admin.close();
          driverOpen = false;
        } catch (error) {
          failures.push(failure('the driver did not close', error));
        }
      }
    }
    failures.push(...closeFailures.splice(0));
    if (failures.length > 0) throw new AggregateError(failures, 'a cleanup step failed');
  };
  /** Stops run one after another, so that two at once never work on the same entry. */
  let stops: Promise<unknown> = Promise.resolve();
  const stop = (): Promise<void> => {
    const run = stops.then(stopOnce, stopOnce);
    stops = run.catch(() => undefined);
    return run;
  };
  const forget = registerOpen(stop);
  const stopAndForget = async (): Promise<void> => {
    await stop();
    forget();
  };

  const createLogin = async (kind: LoginKind): Promise<Login> => {
    const user = names.login(kind);
    const role = names.role(kind);
    const password = randomUUID();
    const database = quote(names.database);
    await make(
      'role',
      role,
      (run) => run(`CREATE ROLE ${quote(role)}`),
      async (run) => {
        await run(`GRANT ACCESS ON DATABASE ${database} TO ${quote(role)}`);
        await run(`GRANT MATCH {*} ON GRAPH ${database} TO ${quote(role)}`);
        await run(`GRANT SHOW INDEX ON DATABASE ${database} TO ${quote(role)}`);
        await run(`GRANT SHOW CONSTRAINT ON DATABASE ${database} TO ${quote(role)}`);
        if (kind === 'writer') {
          await run(`GRANT WRITE ON GRAPH ${database} TO ${quote(role)}`);
          await run(`GRANT NAME MANAGEMENT ON DATABASE ${database} TO ${quote(role)}`);
        }
      },
    );
    await make(
      'user',
      user,
      (run) => run(`CREATE USER ${quote(user)} SET PASSWORD $password CHANGE NOT REQUIRED`, { password }),
      (run) => run(`GRANT ROLE ${quote(role)} TO ${quote(user)}`),
    );
    return { user, password };
  };

  const setReadOnly = async (): Promise<void> => {
    if (closing || !isTestDatabase(names.database) || !owned.some((entry) => entry.kind === 'database' && entry.name === names.database)) throw new Error('refusing to alter a database this run did not make');
    await inSystem(admin, (run) => run(`ALTER DATABASE ${quote(names.database)} SET ACCESS READ ONLY WAIT`), noteClose);
  };

  try {
    const version = await versionOf(admin, noteClose);
    await sweepLeftovers(admin, Date.now(), noteClose).catch((error: unknown) => {
      throw failure('the sweep of leftover test databases failed; the dev login needs to be able to list and drop databases, logins and roles', error);
    });
    await make('database', names.database, (run) => run(`CREATE DATABASE ${quote(names.database)} WAIT 120 SECONDS`)).catch((error: unknown) => {
      throw failure(`could not create a database for the test run; the dev login needs the CREATE DATABASE privilege, and if ${names.database} was made after all, the next sweep drops it`, error);
    });
    const online = await pollUntil(async () => {
      let session;
      try {
        session = admin.session({ database: names.database });
        await session.run('RETURN 1');
        return true;
      } catch {
        return false;
      } finally {
        await session?.close().catch((error: unknown) => void noteClose(failure('a session did not close', error)));
      }
    }, ONLINE_LIMIT_MS);
    if (!online) throw new Error('the test database did not come online');
    return {
      image: `neo4j:${version}`,
      version,
      boltUri: settings.uri,
      user: settings.user,
      password: settings.password,
      database: names.database,
      admin: guardedDriver(admin),
      // the whole creation is tracked, not each of its two parts, so that a stop between them waits for the second too
      createLogin: (kind) => track(createLogin(kind)),
      setReadOnly: () => track(setReadOnly()),
      stop: stopAndForget,
    };
  } catch (error) {
    try {
      await stopAndForget();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'the start failed, and so did the cleanup after it');
    }
    throw error;
  }
}
