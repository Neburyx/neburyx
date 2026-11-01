import type { FastifyBaseLogger } from 'fastify';
import { Logger, parseCronItems, run, type TaskList } from 'graphile-worker';
import { createPool } from '../db/pool.js';
import { cronItemsOf, type Task } from './tasks.js';

const RUNNER_POOL_SIZE = 4;
const silent = new Logger(() => () => undefined);

export interface JobRunner {
  stop(): Promise<void>;
}

export async function startJobRunner(
  url: string,
  tasks: readonly Task[],
  logger: FastifyBaseLogger,
  onConnectionError: () => void,
): Promise<JobRunner | undefined> {
  if (tasks.length === 0) return undefined;
  const pool = createPool(url, onConnectionError, { max: RUNNER_POOL_SIZE });
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
        try {
          await runner.stop();
        } finally {
          await pool.end();
        }
      },
    };
  } catch (error) {
    await pool.end();
    throw error;
  }
}
