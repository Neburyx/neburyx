import neo4j from 'neo4j-driver';
import type { Params, Plan, Row } from '../gate/types.js';

export interface RowObserver {
  onNext(row: Row): void;
  /** `plan` is given when the statement was profiled and the server sent a profile that is small enough to keep. */
  onCompleted(plan?: Plan): void;
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

/** The most operators of a plan that are kept; a larger plan is not a degree probe's. */
export const MAX_PLAN_OPERATORS = 100;
const MAX_DETAILS = 200;

interface ProfiledPlan {
  readonly operatorType: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly dbHits: unknown;
  readonly children: readonly ProfiledPlan[];
}

const numberOf = (value: unknown): number => (neo4j.isInt(value) ? value.toNumber() : typeof value === 'number' ? value : 0);

/** The operators of a profile, flattened, parent before children; the server's `@database` suffix is dropped from a name. `null` when there is none or it is too large. */
export function planOf(profile: ProfiledPlan | false | null | undefined): Plan {
  if (profile === false || profile === null || profile === undefined) return null;
  const operators: Plan & unknown[] = [];
  const visit = (node: ProfiledPlan): boolean => {
    if (operators.length >= MAX_PLAN_OPERATORS) return false;
    const details = node.arguments['Details'];
    operators.push({ name: node.operatorType.replace(/@.*$/, ''), details: typeof details === 'string' ? details.slice(0, MAX_DETAILS) : null, dbHits: numberOf(node.dbHits) });
    return node.children.every(visit);
  };
  return visit(profile) ? operators : null;
}

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
                  onCompleted: (summary) => observer.onCompleted(planOf(summary.profile)),
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
