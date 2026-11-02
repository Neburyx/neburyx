import type { Params, Row } from '../gate/types.js';
import type { DriverFactory, DriverSettings, RowObserver, SessionConfig, TransactionConfig } from '../sources/driver.js';

export type CloseBehaviour = 'ok' | 'hang' | 'reject';

export interface FakeBehaviour {
  readonly rows?: readonly Row[];
  readonly endless?: boolean;
  readonly streamError?: unknown;
  readonly manual?: boolean;
  readonly beginError?: unknown;
  readonly beginHang?: boolean;
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
}

export interface FakeDrivers {
  readonly factory: DriverFactory;
  readonly drivers: FakeDriver[];
  readonly forbidden: string[];
  behaviour: FakeBehaviour;
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
    drivers: [],
    forbidden: [],
    factory: (settings) => {
      const driver: FakeDriver = { settings, sessions: [], closeCalls: 0 };
      fake.drivers.push(driver);
      return Object.assign({
        session: (config: SessionConfig) => {
          const session: FakeSession = { config, begins: [], queries: [], closeCalls: 0 };
          driver.sessions.push(session);
          return Object.assign(
            {
              beginTransaction: async (transaction: TransactionConfig) => {
                session.begins.push(transaction);
                if (fake.behaviour.beginHang === true) return await new Promise<never>(() => undefined);
                if (fake.behaviour.beginGate !== undefined) await fake.behaviour.beginGate;
                if (fake.behaviour.beginError !== undefined) throw fake.behaviour.beginError;
                return {
                  run: (cypher: string, parameters: Params) => {
                    session.queries.push({ cypher, parameters });
                    return {
                      subscribe: (observer: RowObserver) => {
                        session.observer = observer;
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
