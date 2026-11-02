import type { DriverSettings } from '../sources/driver.js';
import type { ProbeDriver, ProbeDriverFactory, ProbeTransaction } from '../sources/write-probe.js';

export interface FakeProbeBehaviour {
  readonly beginError?: unknown;
  readonly beginHang?: boolean;
  readonly runError?: unknown;
  readonly runHang?: boolean;
  readonly rollbackError?: unknown;
  readonly rollbackHang?: boolean;
}

export interface FakeProbeSession {
  readonly config: { readonly database: string; readonly defaultAccessMode: 'WRITE' };
  readonly begins: { readonly timeout: number; readonly metadata: Readonly<Record<string, string>> }[];
  readonly statements: string[];
  rollbacks: number;
  closeCalls: number;
}

export interface FakeProbe {
  readonly factory: ProbeDriverFactory;
  readonly settings: DriverSettings[];
  readonly sessions: FakeProbeSession[];
  readonly forbidden: string[];
  driverCloseCalls: number;
  behaviour: FakeProbeBehaviour;
}

function trap(forbidden: string[], name: string): () => never {
  return () => {
    forbidden.push(name);
    throw new Error(`${name} must not be called`);
  };
}

/** A probe driver that records what the probe does and every call it must never make: commit, a one-shot run on the session, a managed write and a one-shot query. */
export function fakeProbeDriver(initial: FakeProbeBehaviour = {}): FakeProbe {
  const fake: FakeProbe = {
    behaviour: initial,
    settings: [],
    sessions: [],
    forbidden: [],
    driverCloseCalls: 0,
    factory: (settings) => {
      fake.settings.push(settings);
      const driver: ProbeDriver = {
        session: (config) => {
          const session: FakeProbeSession = { config, begins: [], statements: [], rollbacks: 0, closeCalls: 0 };
          fake.sessions.push(session);
          const transaction: ProbeTransaction = Object.assign(
            {
              run: (cypher: string) => {
                session.statements.push(cypher);
                if (fake.behaviour.runHang === true) return new Promise<never>(() => undefined);
                return fake.behaviour.runError === undefined ? Promise.resolve({}) : Promise.reject(fake.behaviour.runError);
              },
              rollback: () => {
                session.rollbacks += 1;
                if (fake.behaviour.rollbackHang === true) return new Promise<void>(() => undefined);
                return fake.behaviour.rollbackError === undefined ? Promise.resolve() : Promise.reject(fake.behaviour.rollbackError);
              },
            },
            { commit: trap(fake.forbidden, 'commit') },
          );
          return Object.assign(
            {
              beginTransaction: (begin: FakeProbeSession['begins'][number]) => {
                session.begins.push(begin);
                if (fake.behaviour.beginHang === true) return new Promise<never>(() => undefined);
                return fake.behaviour.beginError === undefined ? Promise.resolve(transaction) : Promise.reject(fake.behaviour.beginError);
              },
              close: () => {
                session.closeCalls += 1;
                return Promise.resolve();
              },
            },
            {
              run: trap(fake.forbidden, 'session.run'),
              executeWrite: trap(fake.forbidden, 'executeWrite'),
              writeTransaction: trap(fake.forbidden, 'writeTransaction'),
              executeQuery: trap(fake.forbidden, 'session.executeQuery'),
            },
          );
        },
        close: () => {
          fake.driverCloseCalls += 1;
          return Promise.resolve();
        },
      };
      return Object.assign(driver, { executeQuery: trap(fake.forbidden, 'driver.executeQuery') });
    },
  };
  return fake;
}
