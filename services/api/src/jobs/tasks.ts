import { parseCronItems, type CronItem } from 'graphile-worker';

export interface Task {
  readonly name: string;
  readonly run: (payload: unknown) => Promise<void>;
  readonly schedule?: string;
}

export class TaskConfigError extends Error {
  constructor(
    readonly taskName: string,
    reason: 'registered twice' | 'has a schedule that is not a valid cron expression',
  ) {
    super(`invalid configuration: task ${taskName} ${reason}`);
  }
}

export function cronItemsOf(tasks: readonly Task[]): readonly CronItem[] {
  return tasks.flatMap((task) => (task.schedule === undefined ? [] : [{ task: task.name, match: task.schedule, identifier: task.name }]));
}

export function validateTasks(tasks: readonly Task[]): void {
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.name)) throw new TaskConfigError(task.name, 'registered twice');
    seen.add(task.name);
    if (task.schedule === undefined) continue;
    try {
      parseCronItems([{ task: task.name, match: task.schedule, identifier: task.name }]);
    } catch {
      throw new TaskConfigError(task.name, 'has a schedule that is not a valid cron expression');
    }
  }
}
