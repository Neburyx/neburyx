import type { Driver, QueryResult } from 'neo4j-driver';
import { failure } from './errors.js';

export interface AdminTransaction {
  run(cypher: string, parameters?: Record<string, unknown>): Promise<QueryResult>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): Promise<void>;
}

export interface AdminSession {
  run(cypher: string, parameters?: Record<string, unknown>): Promise<QueryResult>;
  beginTransaction(config?: { readonly metadata?: Record<string, unknown>; readonly timeout?: number }): Promise<AdminTransaction>;
  close(): Promise<void>;
}

/** What the tests use of the admin connection: sessions that run statements and transactions. */
export interface AdminDriver {
  session(config?: { readonly database?: string }): AdminSession;
}

async function guarded<T>(what: string, work: () => Promise<T> | T): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw failure(what, error);
  }
}

/** The driver with every error replaced by one that has the server's code and nothing else: a failed connection names its address in the driver's own message. */
export function guardedDriver(driver: Driver): AdminDriver {
  return {
    session(config = {}) {
      let session;
      try {
        session = driver.session(config.database === undefined ? {} : { database: config.database });
      } catch (error) {
        throw failure('could not open a session on the dev Neo4j server', error);
      }
      const opened = session;
      return {
        run: (cypher, parameters = {}) => guarded('a statement of the test failed', () => opened.run(cypher, parameters)),
        beginTransaction: async (transactionConfig = {}) => {
          const transaction = await guarded('a transaction of the test could not begin', () => opened.beginTransaction({ ...transactionConfig, metadata: { ...transactionConfig.metadata } }));
          return {
            run: (cypher, parameters = {}) => guarded('a statement of the test failed', () => transaction.run(cypher, parameters)),
            commit: () => guarded('a transaction of the test could not commit', () => transaction.commit()),
            rollback: () => guarded('a transaction of the test could not roll back', () => transaction.rollback()),
            close: () => guarded('a transaction of the test could not close', () => transaction.close()),
          };
        },
        close: () => guarded('a session of the test did not close', () => opened.close()),
      };
    },
  };
}
