import neo4j from 'neo4j-driver';
import type { GateLogger } from '../gate/types.js';
import type { SourceModel } from '../mapping/model.js';
import type { ProbeAnswer } from '../source-test/probe.js';
import { credentialsOf, driverSettingsOf } from './credentials.js';
import type { DriverSettings } from './driver.js';
import { serverCodeOf } from './errors.js';

/**
 * The statement of the probe: it creates one node with no label and no property and returns a constant, and no input reaches it.
 * The transaction that runs it always ends with a rollback, so the source holds nothing afterwards.
 */
const PROBE_CYPHER = 'CREATE () RETURN 1 AS probe';

/** The codes that prove the server refused the write for this login or database; any other answer proves nothing about the login. */
const REFUSAL_CODES: ReadonlySet<string> = new Set(['Neo.ClientError.Security.Forbidden', 'Neo.ClientError.General.ForbiddenOnReadOnlyDatabase']);

/** What the probe uses of a transaction: one statement and a rollback. */
export interface ProbeTransaction {
  run(cypher: string): PromiseLike<unknown>;
  rollback(): Promise<void>;
}

export interface ProbeSession {
  beginTransaction(config: { readonly timeout: number; readonly metadata: Readonly<Record<string, string>> }): Promise<ProbeTransaction>;
  close(): Promise<void>;
}

export interface ProbeDriver {
  session(config: { readonly database: string; readonly defaultAccessMode: 'WRITE' }): ProbeSession;
  close(): Promise<void>;
}

export type ProbeDriverFactory = (settings: DriverSettings) => ProbeDriver;

/** A driver that exposes only what the probe calls, so no other way to run a statement is within its reach. */
export const neo4jProbeDriverFactory: ProbeDriverFactory = (settings) => {
  const driver = neo4j.driver(settings.uri, neo4j.auth.basic(settings.username, settings.password), {
    maxConnectionPoolSize: settings.maxConnectionPoolSize,
    connectionAcquisitionTimeout: settings.connectionAcquisitionTimeout,
    connectionTimeout: settings.connectionTimeout,
  });
  return {
    session: (config) => {
      const session = driver.session({ database: config.database, defaultAccessMode: neo4j.session.WRITE });
      return {
        beginTransaction: async (transaction) => {
          const open = await session.beginTransaction({ timeout: transaction.timeout, metadata: { ...transaction.metadata } });
          return { run: (cypher) => open.run(cypher), rollback: () => open.rollback() };
        },
        close: () => session.close(),
      };
    },
    close: () => driver.close(),
  };
};

export interface WriteProbeOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly logger: GateLogger;
  readonly createDriver?: ProbeDriverFactory;
}

function answerFor(error: unknown): ProbeAnswer {
  const code = serverCodeOf(error);
  return code !== undefined && REFUSAL_CODES.has(code) ? 'cannot-write' : 'inconclusive';
}

/** Gives up on a step after `ms`, so that a source that does not answer cannot hold the probe. */
async function within<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The one write path of the product: asks the source to run `CREATE ()` in a write transaction on its own driver, then rolls the transaction back, whatever the answer.
 * Only the `test-source` command runs it, and only when asked; it does not go through the gate and it is never part of a read.
 */
export async function runWriteProbe(source: SourceModel, traceId: string, options: WriteProbeOptions): Promise<ProbeAnswer> {
  const credentials = credentialsOf(source, options.env);
  if (credentials === undefined) return 'inconclusive';
  // the longest the probe waits on the source: a connection, then the statement under the transaction's own timeout
  const budgetMs = source.budgets.queueWaitMs + source.budgets.timeoutMs * 2;
  let driver: ProbeDriver | undefined;
  let session: ProbeSession | undefined;
  let transaction: ProbeTransaction | undefined;
  let answer: ProbeAnswer = 'inconclusive';
  try {
    // opening the driver or the session can throw (an address the driver cannot read); that proves nothing about the login
    const opened = (options.createDriver ?? neo4jProbeDriverFactory)(driverSettingsOf(source, credentials, 1));
    driver = opened;
    const sessionOpen = opened.session({ database: source.database, defaultAccessMode: 'WRITE' });
    session = sessionOpen;
    answer = await within(
      (async () => {
        transaction = await sessionOpen.beginTransaction({ timeout: source.budgets.timeoutMs, metadata: { traceId } });
        await transaction.run(PROBE_CYPHER);
        return 'can-write' as const;
      })().catch((error: unknown) => answerFor(error)),
      budgetMs,
      'inconclusive',
    );
    if (transaction !== undefined) {
      await within(
        transaction.rollback().catch(() => {
          options.logger.warn({ event: 'source.write_probe_rollback_failed', sourceId: source.id }, 'source write probe rollback failed');
        }),
        source.budgets.timeoutMs,
        undefined,
      );
    }
  } catch {
    answer = 'inconclusive';
  } finally {
    // closing the session and the driver ends any transaction still open on the server
    if (session !== undefined) await within(session.close().catch(() => undefined), source.budgets.timeoutMs, undefined);
    if (driver !== undefined) await within(driver.close().catch(() => undefined), source.budgets.timeoutMs, undefined);
  }
  return answer;
}
