import type { Backend, Connection, Rows, SessionHandle, TxHandle } from './backend.js';
import type { Look, LookResult } from './probe.js';

export const ONE_ROW: Rows = { records: [{ get: () => 1 }] };
export const NEVER = <T>(): Promise<T> => new Promise<T>(() => undefined);

export interface Script {
  readonly crossProduct?: () => Promise<Rows>;
  readonly txClose?: () => Promise<unknown>;
  readonly sessionClose?: () => Promise<unknown>;
  readonly connectionClose?: () => Promise<unknown>;
  readonly look?: (atMs: number) => Look;
  readonly lookCleanup?: () => Promise<string | undefined>;
  readonly begin?: () => Promise<void>;
}

export interface Event {
  readonly what: string;
  readonly at: number;
}

/** A scripted stand-in for the Neo4j client, recording when each call was made. */
export function fakeBackend(script: Script = {}): { backend: Backend; events: Event[]; lookCalls: () => number } {
  const events: Event[] = [];
  let looks = 0;
  const note = (what: string): void => void events.push({ what, at: performance.now() });
  const tx: TxHandle = {
    run: (query) => {
      note('run');
      return query.includes('a.n + b.n + c.n') ? (script.crossProduct ?? (() => NEVER<Rows>()))() : Promise.resolve(ONE_ROW);
    },
    commit: () => Promise.resolve(),
    close: () => {
      note('tx.close');
      return (script.txClose ?? (() => Promise.resolve()))();
    },
  };
  const session = (): SessionHandle => ({
    beginTransaction: async () => {
      note('begin');
      await (script.begin ?? (() => Promise.resolve()))();
      return tx;
    },
    run: () => Promise.resolve({ records: [{ get: (key: string) => (key === 'version' ? '9.9.9' : 'community') }] }),
    write: () => Promise.resolve(undefined),
    close: () => {
      note('session.close');
      return (script.sessionClose ?? (() => Promise.resolve()))();
    },
  });
  const connection = (): Connection => ({
    session,
    list: () => {
      looks++;
      const now = performance.now();
      const look = (script.look ?? (() => ({ state: 'running' })))(now);
      return Promise.resolve({ look, answeredAt: now, cleanup: (script.lookCleanup ?? (() => Promise.resolve(undefined)))() } satisfies LookResult);
    },
    close: () => {
      note('connection.close');
      return (script.connectionClose ?? (() => Promise.resolve()))();
    },
  });
  return { backend: { driverVersion: '9.9.9', connect: connection }, events, lookCalls: () => looks };
}
