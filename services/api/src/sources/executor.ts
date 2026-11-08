import type { UnavailableReason } from '../errors.js';
import type { Clock, GateLogger, Row } from '../gate/types.js';
import type { ExecuteCall, ExecuteOutcome, ReadExecutor } from '../gate/executor.js';
import type { SourceModel } from '../mapping/model.js';
import { credentialsOf, driverSettingsOf } from './credentials.js';
import { neo4jDriverFactory, type DriverFactory, type SourceDriver, type SourceSession, type SourceTransaction } from './driver.js';
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

/**
 * The longest the end of a read waits for the rollback of its transaction before it closes the session anyway. A rollback on a healthy source answers in a few milliseconds;
 * one that has not answered by now never delays the answer to the caller (the answer is given before the cleanup starts), only the close of the session, which must happen.
 */
const ROLLBACK_WAIT_MS = 1000;

const unavailable = (reason: UnavailableReason): ExecuteOutcome => ({ status: 'unavailable', reason });
const TIMEOUT: ExecuteOutcome = { status: 'timeout' };
const CANCELLED: ExecuteOutcome = { status: 'cancelled' };

const startNow = (work: () => Promise<void>): Promise<void> => {
  try {
    return Promise.resolve(work());
  } catch (error) {
    return Promise.reject(error);
  }
};

export function createNeo4jExecutor(options: Neo4jExecutorOptions): Neo4jExecutor {
  const clock = options.clock ?? Date.now;
  const createDriver = options.createDriver ?? neo4jDriverFactory;
  const sources = new Map(options.sources.map((source) => [source.id, source]));
  const drivers = new Map<string, SourceDriver>();
  const pending = new Set<Promise<void>>();
  let closing: Promise<void> | undefined;

  /** Runs a piece of cleanup, bounded by the source's timeout; `now` starts the work in this call and not in the next microtask, for a close that must be asked before the caller goes on. */
  function cleanUp(source: SourceModel, work: () => Promise<void>, now = false): Promise<void> {
    const run = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const tooSlow = new Promise<'slow'>((resolve) => {
        timer = setTimeout(() => resolve('slow'), source.budgets.timeoutMs);
      });
      const started = now ? startNow(work) : Promise.resolve().then(work);
      const done = started
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
    return run;
  }

  function driverFor(source: SourceModel): SourceDriver | undefined {
    const existing = drivers.get(source.id);
    if (existing !== undefined) return existing;
    const credentials = credentialsOf(source, options.env);
    if (credentials === undefined) {
      options.logger.warn({ event: 'source.credentials_missing', sourceId: source.id }, 'source credentials are not set');
      return undefined;
    }
    // the read slots bound the reads that run; a slot can also have one connection still closing behind the read that holds it, as when the next page of an expansion starts
    const driver = createDriver(driverSettingsOf(source, credentials, source.budgets.sourceConcurrency * 2));
    drivers.set(source.id, driver);
    return driver;
  }

  /**
   * Ends a read's session: rolls its transaction back first, so that the driver cancels a result that is still streaming, waiting at most `ROLLBACK_WAIT_MS` for the answer,
   * and then closes the session, whatever the rollback did (an answer, a failure, nothing). A transaction that the server has already ended answers the rollback with a
   * failure, which is the normal end of a read that failed and is not reported.
   */
  async function endRead(source: SourceModel, session: SourceSession, transaction: SourceTransaction | undefined): Promise<void> {
    if (transaction !== undefined) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waited = new Promise<'slow'>((resolve) => {
        timer = setTimeout(() => resolve('slow'), ROLLBACK_WAIT_MS);
      });
      const rolledBack = Promise.resolve()
        .then(() => transaction.rollback())
        .then(
          () => 'done' as const,
          () => 'done' as const,
        );
      const result = await Promise.race([rolledBack, waited]);
      clearTimeout(timer);
      if (result === 'slow') options.logger.warn({ event: 'source.rollback_slow', sourceId: source.id }, 'source rollback is taking too long');
    }
    await session.close();
  }

  function discard(source: SourceModel, driver: SourceDriver): void {
    if (drivers.get(source.id) === driver) drivers.delete(source.id);
    void cleanUp(source, () => driver.close());
  }

  function read(source: SourceModel, driver: SourceDriver, call: ExecuteCall, remainingMs: number): Promise<ExecuteOutcome> {
    return new Promise<ExecuteOutcome>((resolve, reject) => {
      const rows: Row[] = [];
      let settled = false;
      let guard: ReturnType<typeof setTimeout> | undefined;
      let session: SourceSession | undefined;
      let transaction: SourceTransaction | undefined;

      const settle = (finish: () => void, cancelled = false): void => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        call.signal?.removeEventListener('abort', onAbort);
        const toClose = session;
        const toRollBack = transaction;
        // said before the outcome, so the gate keeps the read's slots until its connection is back and a slot holder does not wait for a connection
        if (toClose !== undefined) {
          // a cancel closes the session at once, with no rollback first: a rollback of a running query does not free the caller (TAS §13), and the session's close stops the query
          const closed = cancelled ? cleanUp(source, () => toClose.close(), true) : cleanUp(source, () => endRead(source, toClose, toRollBack));
          call.onClosed?.(closed);
        }
        finish();
      };
      const onAbort = (): void => settle(() => resolve(CANCELLED), true);
      const fail = (error: unknown): void => {
        settle(() => {
          const kind = classify(error);
          if (kind === 'timeout') resolve(TIMEOUT);
          else if (kind === 'unreachable' || kind === 'pool-full') resolve(unavailable(kind));
          else if (kind === 'authentication') {
            discard(source, driver);
            resolve(unavailable('authentication'));
          } else if (kind === 'database' || kind === 'refused') {
            options.logger.warn({ event: 'source.read_failed', sourceId: source.id, serverCode: serverCodeOf(error) }, 'source read failed');
            resolve(unavailable(kind));
          } else {
            options.logger.warn({ event: 'source.read_failed', sourceId: source.id, serverCode: serverCodeOf(error) }, 'source read failed');
            reject(new AdapterError('READ_FAILED'));
          }
        });
      };

      guard = setTimeout(() => settle(() => resolve(TIMEOUT)), remainingMs);
      call.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        session = driver.session({ database: source.database, defaultAccessMode: 'READ', fetchSize: call.rowLimit });
        const timeout = Math.max(1, Math.floor(Math.min(call.timeoutMs, remainingMs)));
        session
          .beginTransaction({ timeout, metadata: { traceId: call.traceId, templateId: call.templateId, templateVersion: call.templateVersion } })
          .then((begun) => {
            if (settled) return;
            transaction = begun;
            begun.run(call.cypher, prepareParameters(call.parameters, call.integerParameters ?? [])).subscribe({
              onNext: (row) => {
                if (settled) return;
                rows.push(row);
                if (rows.length >= call.rowLimit) settle(() => resolve(call.profile === true ? { status: 'rows', rows, plan: null } : { status: 'rows', rows }));
              },
              onCompleted: (plan) => settle(() => resolve(call.profile === true ? { status: 'rows', rows, plan: plan ?? null } : { status: 'rows', rows })),
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
      if (closing !== undefined || source === undefined) return unavailable('closed');
      if (call.signal?.aborted === true) return CANCELLED;
      const remainingMs = call.deadlineAt - clock();
      if (remainingMs <= 0) return TIMEOUT;
      let driver: SourceDriver | undefined;
      try {
        driver = driverFor(source);
      } catch (error) {
        options.logger.warn({ event: 'source.read_failed', sourceId: source.id, serverCode: serverCodeOf(error) }, 'source read failed');
        throw new AdapterError('READ_FAILED');
      }
      if (driver === undefined) return unavailable('credentials');
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
