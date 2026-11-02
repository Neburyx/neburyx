import type { Params, Row } from '../gate/types.js';
import { fittingIndexes, fittingTokens, NO_DUPLICATES } from './fitting-schema.js';
import type { DriverFactory, DriverSettings, RowObserver, SessionConfig, TransactionConfig } from '../sources/driver.js';

export type CloseBehaviour = 'ok' | 'hang' | 'reject';

export interface FakeBehaviour {
  readonly rows?: readonly Row[];
  /** The rows of the privileges read; absent, the read ends as a Community server ends it, with the server's refusal. */
  readonly privileges?: readonly Row[];
  readonly privilegesError?: unknown;
  readonly privilegesHang?: boolean;
  /** The rows of the schema reads; absent, a read answers as a source whose schema fits the mapping. */
  readonly schemaTokens?: readonly Row[];
  readonly schemaIndexes?: readonly Row[];
  readonly scans?: readonly Row[];
  /** Fails a schema read with this error, whichever of the three it is, when set for it: `tokens`, `indexes` or `scan`. */
  readonly schemaError?: { readonly read: 'tokens' | 'indexes' | 'scan'; readonly error: unknown };
  readonly schemaHang?: 'tokens' | 'indexes' | 'scan';
  readonly endless?: boolean;
  readonly streamError?: unknown;
  readonly manual?: boolean;
  readonly beginError?: unknown;
  readonly beginHang?: boolean;
  /** Fails the transactions after the first one, as when the capabilities read answered and the next read does not. */
  readonly laterBeginError?: unknown;
  readonly laterBeginHang?: boolean;
  readonly beginGate?: Promise<void>;
  readonly sessionClose?: CloseBehaviour;
  readonly driverClose?: CloseBehaviour;
}

export interface FakeSession {
  readonly config: SessionConfig;
  readonly begins: TransactionConfig[];
  readonly queries: { readonly cypher: string; readonly parameters: Params }[];
  closeCalls: number;
  observer?: RowObserver;
}

export interface FakeDriver {
  readonly settings: DriverSettings;
  readonly sessions: FakeSession[];
  closeCalls: number;
  /** The transactions begun on this driver, so a later read of one source is told from the first read of another. */
  begins: number;
}

export interface FakeDrivers {
  readonly factory: DriverFactory;
  readonly drivers: FakeDriver[];
  readonly forbidden: string[];
  begins: number;
  behaviour: FakeBehaviour;
}

const COMMUNITY_REFUSAL = 'Neo.ClientError.Statement.UnsupportedAdministrationCommand';
const isPrivileges = (cypher: string): boolean => cypher.startsWith('SHOW USER PRIVILEGES');

/** Which schema read a statement is, from the start of its fixed Cypher. */
function schemaReadOf(cypher: string): 'tokens' | 'indexes' | 'scan' | undefined {
  if (cypher.startsWith('CALL { CALL db.labels()')) return 'tokens';
  if (cypher.startsWith('SHOW INDEXES')) return 'indexes';
  return cypher.includes('USING INDEX') ? 'scan' : undefined;
}

function settle(how: CloseBehaviour | undefined): Promise<void> {
  if (how === 'hang') return new Promise<void>(() => undefined);
  if (how === 'reject') return Promise.reject(new Error('close failed'));
  return Promise.resolve();
}

function trap(forbidden: string[], name: string): () => never {
  return () => {
    forbidden.push(name);
    throw new Error(`${name} must not be called`);
  };
}

export function fakeDrivers(initial: FakeBehaviour = {}): FakeDrivers {
  const fake: FakeDrivers = {
    behaviour: initial,
    begins: 0,
    drivers: [],
    forbidden: [],
    factory: (settings) => {
      const driver: FakeDriver = { settings, sessions: [], closeCalls: 0, begins: 0 };
      fake.drivers.push(driver);
      return Object.assign({
        session: (config: SessionConfig) => {
          const session: FakeSession = { config, begins: [], queries: [], closeCalls: 0 };
          driver.sessions.push(session);
          return Object.assign(
            {
              beginTransaction: async (transaction: TransactionConfig) => {
                session.begins.push(transaction);
                fake.begins += 1;
                driver.begins += 1;
                if (driver.begins > 1 && fake.behaviour.laterBeginHang === true) return await new Promise<never>(() => undefined);
                if (driver.begins > 1 && fake.behaviour.laterBeginError !== undefined) throw fake.behaviour.laterBeginError;
                if (fake.behaviour.beginHang === true) return await new Promise<never>(() => undefined);
                if (fake.behaviour.beginGate !== undefined) await fake.behaviour.beginGate;
                if (fake.behaviour.beginError !== undefined) throw fake.behaviour.beginError;
                return {
                  run: (cypher: string, parameters: Params) => {
                    session.queries.push({ cypher, parameters });
                    return {
                      subscribe: (observer: RowObserver) => {
                        session.observer = observer;
                        const schemaRead = schemaReadOf(cypher);
                        if (schemaRead !== undefined) {
                          if (fake.behaviour.schemaHang === schemaRead) return;
                          if (fake.behaviour.schemaError?.read === schemaRead) {
                            observer.onError(fake.behaviour.schemaError.error);
                            return;
                          }
                          const given = { tokens: fake.behaviour.schemaTokens, indexes: fake.behaviour.schemaIndexes, scan: fake.behaviour.scans }[schemaRead];
                          for (const row of given ?? [{ tokens: fittingTokens(parameters), indexes: fittingIndexes(parameters), scan: NO_DUPLICATES }[schemaRead]]) observer.onNext(row);
                          observer.onCompleted();
                          return;
                        }
                        if (isPrivileges(cypher)) {
                          if (fake.behaviour.privilegesHang === true) return;
                          if (fake.behaviour.privileges !== undefined) {
                            for (const row of fake.behaviour.privileges) observer.onNext(row);
                            observer.onCompleted();
                          } else observer.onError(fake.behaviour.privilegesError ?? neo4jError(COMMUNITY_REFUSAL));
                          return;
                        }
                        if (fake.behaviour.manual === true) return;
                        for (const row of fake.behaviour.rows ?? []) observer.onNext(row);
                        if (fake.behaviour.streamError !== undefined) observer.onError(fake.behaviour.streamError);
                        else if (fake.behaviour.endless !== true) observer.onCompleted();
                      },
                    };
                  },
                };
              },
              close: () => {
                session.closeCalls += 1;
                return settle(fake.behaviour.sessionClose);
              },
            },
            {
              executeRead: trap(fake.forbidden, 'executeRead'),
              executeWrite: trap(fake.forbidden, 'executeWrite'),
              readTransaction: trap(fake.forbidden, 'readTransaction'),
              writeTransaction: trap(fake.forbidden, 'writeTransaction'),
              executeQuery: trap(fake.forbidden, 'session.executeQuery'),
              run: trap(fake.forbidden, 'session.run'),
            },
          );
        },
        close: () => {
          driver.closeCalls += 1;
          return settle(fake.behaviour.driverClose);
        },
      }, { executeQuery: trap(fake.forbidden, 'driver.executeQuery') });
    },
  };
  return fake;
}

export function neo4jError(code: string, message = 'a message the adapter must not repeat'): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code });
}

export function expectNoForbiddenCalls(fake: FakeDrivers): void {
  if (fake.forbidden.length > 0) throw new Error(`forbidden driver calls: ${fake.forbidden.join(', ')}`);
}
