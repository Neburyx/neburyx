import type { Clock, GateLogger, Row } from '../gate/types.js';
import type { ExecuteCall, ExecuteOutcome, ReadExecutor } from '../gate/executor.js';
import type { SourceModel } from '../mapping/model.js';
import { neo4jDriverFactory, type DriverFactory, type SourceDriver, type SourceSession } from './driver.js';
import { AdapterError, classify, serverCodeOf } from './errors.js';
import { prepareParameters } from './parameters.js';
import { OPERATIONS, type CancelResult } from './operations.js';

export interface Neo4jExecutorOptions {
  readonly sources: readonly SourceModel[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly logger: GateLogger;
  readonly clock?: Clock;
  readonly createDriver?: DriverFactory;
}

export interface Neo4jExecutor extends ReadExecutor {
  readonly operations: typeof OPERATIONS;
  cancel(operationId: string): Promise<CancelResult>;
  close(): Promise<void>;
}

const UNAVAILABLE: ExecuteOutcome = { status: 'unavailable' };
const TIMEOUT: ExecuteOutcome = { status: 'timeout' };

export function createNeo4jExecutor(options: Neo4jExecutorOptions): Neo4jExecutor {
  const clock = options.clock ?? Date.now;
  const createDriver = options.createDriver ?? neo4jDriverFactory;
  const sources = new Map(options.sources.map((source) => [source.id, source]));
  const drivers = new Map<string, SourceDriver>();
  const pending = new Set<Promise<void>>();
  let closing: Promise<void> | undefined;

  function cleanUp(source: SourceModel, work: () => Promise<void>): void {
    const run = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const tooSlow = new Promise<'slow'>((resolve) => {
        timer = setTimeout(() => resolve('slow'), source.budgets.timeoutMs);
      });
      const done = Promise.resolve()
        .then(work)
        .then(
          () => 'done' as const,
          () => 'failed' as const,
        );
      const result = await Promise.race([done, tooSlow]);
      clearTimeout(timer);
      if (result === 'failed') options.logger.warn({ event: 'source.cleanup_failed', sourceId: source.id }, 'source cleanup failed');
      if (result === 'slow') options.logger.warn({ event: 'source.cleanup_slow', sourceId: source.id }, 'source cleanup is taking too long');
    })();
    pending.add(run);
    void run.finally(() => pending.delete(run));
  }

  function driverFor(source: SourceModel): SourceDriver | undefined {
    const existing = drivers.get(source.id);
    if (existing !== undefined) return existing;
    const username = options.env[source.auth.usernameEnv];
    const password = options.env[source.auth.passwordEnv];
    if (username === undefined || username === '' || password === undefined || password === '') {
      options.logger.warn({ event: 'source.credentials_missing', sourceId: source.id }, 'source credentials are not set');
      return undefined;
    }
    const driver = createDriver({
      uri: source.uri,
      username,
      password,
      maxConnectionPoolSize: source.budgets.sourceConcurrency,
      connectionAcquisitionTimeout: source.budgets.queueWaitMs,
      connectionTimeout: source.budgets.timeoutMs,
    });
    drivers.set(source.id, driver);
    return driver;
  }

  function discard(source: SourceModel, driver: SourceDriver): void {
    if (drivers.get(source.id) === driver) drivers.delete(source.id);
    cleanUp(source, () => driver.close());
  }

  function read(source: SourceModel, driver: SourceDriver, call: ExecuteCall, remainingMs: number): Promise<ExecuteOutcome> {
    return new Promise<ExecuteOutcome>((resolve, reject) => {
      const rows: Row[] = [];
      let settled = false;
      let guard: ReturnType<typeof setTimeout> | undefined;
      let session: SourceSession | undefined;

      const settle = (finish: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        finish();
        const toClose = session;
        if (toClose !== undefined) cleanUp(source, () => toClose.close());
      };
      const fail = (error: unknown): void => {
        settle(() => {
          const kind = classify(error);
          if (kind === 'timeout') resolve(TIMEOUT);
          else if (kind === 'unavailable') resolve(UNAVAILABLE);
          else if (kind === 'authentication') {
            discard(source, driver);
            resolve(UNAVAILABLE);
          } else {
            options.logger.warn({ event: 'source.read_failed', sourceId: source.id, serverCode: serverCodeOf(error) }, 'source read failed');
            reject(new AdapterError('READ_FAILED'));
          }
        });
      };

      guard = setTimeout(() => settle(() => resolve(TIMEOUT)), remainingMs);
      try {
        session = driver.session({ database: source.database, defaultAccessMode: 'READ', fetchSize: call.rowLimit });
        const timeout = Math.max(1, Math.floor(Math.min(call.timeoutMs, remainingMs)));
        session
          .beginTransaction({ timeout, metadata: { traceId: call.traceId, templateId: call.templateId, templateVersion: call.templateVersion } })
          .then((transaction) => {
            if (settled) return;
            transaction.run(call.cypher, prepareParameters(call.parameters, call.integerParameters ?? [])).subscribe({
              onNext: (row) => {
                if (settled) return;
                rows.push(row);
                if (rows.length >= call.rowLimit) settle(() => resolve({ status: 'rows', rows }));
              },
              onCompleted: () => settle(() => resolve({ status: 'rows', rows })),
              onError: fail,
            });
          })
          .catch(fail);
      } catch (error) {
        fail(error);
      }
    });
  }

  return {
    operations: OPERATIONS,
    cancel: () => Promise.resolve({ status: 'unsupported' }),
    async execute(call) {
      const mode: string = call.accessMode;
      if (mode !== 'READ') throw new AdapterError('NOT_READ_ONLY');
      const source = sources.get(call.sourceId);
      if (closing !== undefined || source === undefined) return UNAVAILABLE;
      const remainingMs = call.deadlineAt - clock();
      if (remainingMs <= 0) return TIMEOUT;
      let driver: SourceDriver | undefined;
      try {
        driver = driverFor(source);
      } catch (error) {
        options.logger.warn({ event: 'source.read_failed', sourceId: source.id, serverCode: serverCodeOf(error) }, 'source read failed');
        throw new AdapterError('READ_FAILED');
      }
      if (driver === undefined) return UNAVAILABLE;
      return await read(source, driver, call, remainingMs);
    },
    close() {
      closing ??= (async () => {
        await Promise.all([...pending]);
        const open = [...drivers];
        drivers.clear();
        const results = await Promise.allSettled(open.map(([, driver]) => driver.close()));
        results.forEach((result, index) => {
          if (result.status === 'rejected') options.logger.warn({ event: 'source.driver_close_failed', sourceId: open[index]?.[0] }, 'source driver did not close');
        });
      })();
      return closing;
    },
  };
}
