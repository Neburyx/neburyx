import { ref } from '../../../apps/web/src/state/test-data.js';
import type { ExecuteCall, ExecuteOutcome } from '../../../services/api/src/gate/executor.js';
import { EXPAND_NEIGHBORS_ID } from '../../../services/api/src/gate/templates/expand-neighbors.js';
import { createNeo4jExecutor } from '../../../services/api/src/sources/executor.js';
import { buildSupernodes, ENTITIES, hubOf, RELATIONSHIPS } from '../../../services/api/src/testing/benchmark/fixture.js';
import { forwardTo, type Forwarder } from '../../../services/api/src/testing/forwarder.js';
import { envFor, runAll, seedItems, SLOW_READ, sourceFor, startNeo4j, type RunningNeo4j } from '../../../services/api/src/testing/neo4j-server.js';
import { startOn, type Rig } from './rig.js';

/** The real adapter on a database of this run's own, behind a forwarder that can close the port, with a way to make the next expansion reads slow. */
export interface Neo4jRig extends Rig {
  readonly server: RunningNeo4j;
  readonly forwarder: Forwarder;
  /** Makes every later expansion read run the slow read of the Neo4j tests in place of the expansion's statement (the adapter, the session and the server's timeout are the real ones; the statement is not the expand template). */
  slow(on: boolean): void;
}

const none = (): never => {
  throw new Error('a Neo4j rig has no scripted reads');
};

/** `size` relationships of each type on one node of a database of this run's own, and the product's API and web client in front of it. */
export async function startNeo4jRig(options: { readonly size: number; readonly timeoutMs?: number }): Promise<Neo4jRig> {
  const server = await startNeo4j();
  let forwarder: Forwarder | undefined;
  let rig: Rig | undefined;
  try {
    await buildSupernodes(server, [options.size]);
    await seedItems(server);
    forwarder = await forwardTo(server.boltUri);
    const source = sourceFor(server, { uri: forwarder.url, entities: ENTITIES, relationships: RELATIONSHIPS, ...(options.timeoutMs === undefined ? {} : { budgets: { timeout_ms: options.timeoutMs } }) });
    const inner = createNeo4jExecutor({ sources: [source], env: envFor(server), logger: { warn: () => undefined } });
    let slowOn = false;
    const calls: ExecuteCall[] = [];
    const executor = {
      calls,
      execute: (call: ExecuteCall): Promise<ExecuteOutcome> => {
        calls.push(call);
        return inner.execute(slowOn && call.templateId === EXPAND_NEIGHBORS_ID ? { ...call, cypher: SLOW_READ, parameters: {}, integerParameters: [] } : call);
      },
    };
    const stopAll = (): Promise<void> => runAll([() => inner.close(), () => forwarder?.stop(), () => server.stop()]);
    rig = await startOn({ mapping: { sources: [source] }, executor, hub: ref(source.id, 'hub', hubOf(options.size)), nextRead: none, drain: none, time: { get now() { return Date.now(); }, set now(_value: number) { /* real time */ } }, stop: stopAll }, {});
    const started = rig;
    return Object.assign(Object.create(Object.getPrototypeOf(started) as object) as Rig, started, { server, forwarder, slow: (on: boolean) => void (slowOn = on) }) as Neo4jRig;
  } catch (error) {
    await runAll([() => rig?.close(), () => forwarder?.stop(), () => server.stop()]);
    throw error;
  }
}

/** After a rig was closed: whether the database, the logins and the roles it made are still on the server. Starts a short connection of its own and drops what that makes. */
export async function leftoversOf(rig: Neo4jRig): Promise<readonly string[]> {
  const database = rig.server.database;
  const stamp = database.replace(/^nbx-test-/, '').replaceAll('-', '_');
  await rig.close();
  const probe = await startNeo4j();
  try {
    const session = probe.admin.session({ database: 'system' });
    try {
      const names = async (cypher: string, column: string): Promise<string[]> => (await session.run(cypher)).records.map((record) => String(record.get(column)));
      const databases = await names('SHOW DATABASES YIELD name RETURN name', 'name');
      const users = await names('SHOW USERS YIELD user RETURN user', 'user');
      const roles = await names('SHOW ROLES YIELD role RETURN role', 'role');
      return [
        ...databases.filter((name) => name === database).map((name) => `database ${name}`),
        ...users.filter((name) => name.includes(stamp)).map((name) => `login ${name}`),
        ...roles.filter((name) => name.includes(stamp)).map((name) => `role ${name}`),
      ];
    } finally {
      await session.close();
    }
  } finally {
    await probe.stop();
  }
}
