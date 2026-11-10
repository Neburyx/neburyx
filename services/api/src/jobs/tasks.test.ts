import { describe, expect, it } from 'vitest';
import { TaskConfigError, validateTasks, type Task } from './tasks.js';

const task = (name: string, schedule?: string): Task => ({ name, run: () => Promise.resolve(), ...(schedule === undefined ? {} : { schedule }) });

describe('validateTasks', () => {
  it('accepts no tasks, several tasks and a valid schedule', () => {
    expect(() => validateTasks([])).not.toThrow();
    expect(() => validateTasks([task('a'), task('b', '* * * * *'), task('c', '*/5 3 * * 1')])).not.toThrow();
  });

  it('names a task that is registered twice', () => {
    const failure = (): void => validateTasks([task('purge'), task('other'), task('purge')]);
    expect(failure).toThrow(TaskConfigError);
    expect(failure).toThrow('invalid configuration: task purge registered twice');
  });

  it.each(['', 'never', '61 * * * *', '* * *', '* * * * * * *'])('names a task whose schedule %j is not a cron expression', (schedule) => {
    const failure = (): void => validateTasks([task('expire', schedule)]);
    expect(failure).toThrow(TaskConfigError);
    expect(failure).toThrow('invalid configuration: task expire has a schedule that is not a valid cron expression');
  });
});
