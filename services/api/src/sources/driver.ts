import neo4j from 'neo4j-driver';
import type { Params, Row } from '../gate/types.js';

export interface RowObserver {
  onNext(row: Row): void;
  onCompleted(): void;
  onError(error: unknown): void;
}

export interface RowStream {
  subscribe(observer: RowObserver): void;
}

export interface TransactionConfig {
  readonly timeout: number;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface SourceTransaction {
  run(cypher: string, parameters: Params): RowStream;
}

export interface SessionConfig {
  readonly database: string;
  readonly defaultAccessMode: 'READ';
  readonly fetchSize: number;
}

export interface SourceSession {
  beginTransaction(config: TransactionConfig): Promise<SourceTransaction>;
  close(): Promise<void>;
}

export interface SourceDriver {
  session(config: SessionConfig): SourceSession;
  close(): Promise<void>;
}

export interface DriverSettings {
  readonly uri: string;
  readonly username: string;
  readonly password: string;
  readonly maxConnectionPoolSize: number;
  readonly connectionAcquisitionTimeout: number;
  readonly connectionTimeout: number;
}

export type DriverFactory = (settings: DriverSettings) => SourceDriver;

export const neo4jDriverFactory: DriverFactory = (settings) => {
  const driver = neo4j.driver(settings.uri, neo4j.auth.basic(settings.username, settings.password), {
    maxConnectionPoolSize: settings.maxConnectionPoolSize,
    connectionAcquisitionTimeout: settings.connectionAcquisitionTimeout,
    connectionTimeout: settings.connectionTimeout,
  });
  return {
    session: (config) => {
      const session = driver.session({ database: config.database, defaultAccessMode: neo4j.session.READ, fetchSize: config.fetchSize });
      return {
        beginTransaction: async (transaction) => {
          const open = await session.beginTransaction({ timeout: transaction.timeout, metadata: { ...transaction.metadata } });
          return {
            run: (cypher, parameters) => ({
              subscribe: (observer) => {
                open.run(cypher, { ...parameters }).subscribe({
                  onNext: (record) => observer.onNext(record.toObject()),
                  onCompleted: () => observer.onCompleted(),
                  onError: (error) => observer.onError(error),
                });
              },
            }),
          };
        },
        close: () => session.close(),
      };
    },
    close: () => driver.close(),
  };
};
