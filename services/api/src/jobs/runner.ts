import type { FastifyBaseLogger } from 'fastify';
import { Logger, parseCronItems, run, type TaskList } from 'graphile-worker';
import type { AddressCache } from '../db/lookup.js';
import { createPool } from '../db/pool.js';
import { cronItemsOf, type Task } from './tasks.js';

const RUNNER_POOL_SIZE = 4;
/** How long stopping the runner waits for a database that does not answer, so a stuck connection cannot hold the process open. */
const RUNNER_STOP_LIMIT_MS = 2000;
const silent = new Logger(() => () => undefined);

export interface JobRunner {
  stop(): Promise<void>;
}

export interface JobRunnerOptions {
  readonly connectionTimeoutMs?: number;
  readonly addresses?: AddressCache;
}

export async function startJobRunner(
  url: string,
  tasks: readonly Task[],
  logger: FastifyBaseLogger,
  onConnectionError: () => void,
  options: JobRunnerOptions = {},
): Promise<JobRunner | undefined> {
  if (tasks.length === 0) return undefined;
  const pool = createPool(url, onConnectionError, {
    max: RUNNER_POOL_SIZE,
    ...(options.addresses === undefined ? {} : { addresses: options.addresses }),
    ...(options.connectionTimeoutMs === undefined ? {} : { connectionTimeoutMs: options.connectionTimeoutMs }),
  });
  const taskList: TaskList = Object.fromEntries(tasks.map((task) => [task.name, (payload: unknown) => task.run(payload)]));
  try {
    const runner = await run({
      pgPool: pool,
      taskList,
      parsedCronItems: parseCronItems([...cronItemsOf(tasks)]),
      concurrency: 1,
      preset: { worker: { completeJobBatchDelay: 0, failJobBatchDelay: 0 } },
      noHandleSignals: true,
      logger: silent,
    });
    runner.events.on('job:error', ({ job }) => {
      logger.error({ event: 'job.failed', task: job.task_identifier }, 'job failed');
    });
    return {
      async stop(): Promise<void> {
        let timer: NodeJS.Timeout | undefined;
        const limit = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, RUNNER_STOP_LIMIT_MS);
        });
        const stopped = (async () => {
          try {
            await runner.stop();
          } finally {
            await pool.end();
          }
        })();
        // the work is given up at the limit, not stopped: its failure after that is not ours to report
        stopped.catch(() => undefined);
        try {
          const finished = await Promise.race([stopped.then(() => true), limit.then(() => false)]);
          // a purge that is cut here is one transaction at most, which the database rolls back, and the next run takes it again
          if (!finished) logger.warn({ event: 'job.runner_stop_timeout' }, 'the job runner did not stop in time and was given up');
        } finally {
          clearTimeout(timer);
        }
      },
    };
  } catch (error) {
    await pool.end();
    throw error;
  }
}
