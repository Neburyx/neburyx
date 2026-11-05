import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isStopping, resumeTracked, runTracked, stopTracked } from './children.ts';
import { restoreOnInterrupt } from './interrupt.ts';
import { checkBrokenBinding, type TestRun } from './mutation.ts';

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A command that starts a long-lived child of its own, writes the child's pid to a file once it exists, and then waits. */
const withGrandchild = (pidFile: string): string =>
  `const { spawn } = require('node:child_process'); const { writeFileSync } = require('node:fs'); const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' }); writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); setTimeout(() => {}, 60000);`;

const directories: string[] = [];
const scratch = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'ux-children-'));
  directories.push(directory);
  return directory;
};
const pidOf = async (file: string): Promise<number> => {
  await vi.waitFor(() => expect(existsSync(file) && readFileSync(file, 'utf8') !== '').toBe(true), { timeout: 15_000, interval: 50 });
  return Number(readFileSync(file, 'utf8'));
};

afterEach(async () => {
  await stopTracked();
  resumeTracked();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('the commands of the broken binding check', () => {
  it('does not wait on a command that writes four megabytes to its error output before its report', async () => {
    const finished = await runTracked(process.execPath, ['-e', "process.stderr.write('x'.repeat(4 * 1024 * 1024)); process.stdout.write('{\"ok\":true}')"], process.cwd());
    expect(finished.stdout).toBe('{"ok":true}');
    expect(finished.stderr.length).toBeLessThanOrEqual(4000);
    expect(finished.code).toBe(0);
  }, 20_000);

  it('stops a command with what it started, gives back once they have ended, and starts nothing more', async () => {
    const file = join(scratch(), 'pid');
    const wait = runTracked(process.execPath, ['-e', withGrandchild(file)], process.cwd());
    const grandchild = await pidOf(file);
    await stopTracked();
    expect((await wait).signal).toBe('SIGKILL');
    await vi.waitFor(() => expect(alive(grandchild)).toBe(false), { timeout: 5000, interval: 25 });
    expect(isStopping()).toBe(true);
    await expect(runTracked(process.execPath, ['-e', ''], process.cwd())).rejects.toThrow('COMMANDS_STOPPED');
  }, 30_000);

  it('does not start the third run when an interrupt comes during the second, and leaves no process behind', async () => {
    const directory = scratch();
    const log: string[] = [];
    const pids: string[] = [];
    const source = new EventEmitter();
    let finished = false;
    restoreOnInterrupt(source, {
      stopChildren: async () => {
        log.push('stop');
        await stopTracked();
        log.push('stopped');
      },
      restoreSource: () => void log.push('restore'),
      rebuild: () => void log.push('rebuild'),
      exit: (code) => {
        log.push(`exit ${code}`);
        finished = true;
      },
      report: (error) => void log.push(`reported ${String(error)}`),
    });
    let runs = 0;
    let thirdRan = false;
    const run = async (): Promise<TestRun> => {
      runs += 1;
      const file = join(directory, `pid-${runs}`);
      pids.push(file);
      const result = runTracked(process.execPath, ['-e', runs === 2 ? withGrandchild(file) : "process.stdout.write(JSON.stringify({ stats: { expected: 1 }, suites: [{ specs: [{ title: 't', tests: [{ results: [{ status: 'passed' }] }] }] }] }))"], process.cwd());
      if (runs === 2) {
        const secondPid = await pidOf(file);
        pids[1] = String(secondPid);
        source.emit('SIGTERM');
      }
      const done = await result;
      if (runs === 3) thirdRan = true;
      return done.signal === null ? { failures: [], errors: [], passed: 1 } : { failures: [], errors: [`ended by ${done.signal}`], passed: 0 };
    };
    await checkBrokenBinding({
      run,
      breakBinding: async () => void log.push('break'),
      restore: async () => void log.push('normal restore'),
      expected: { title: 't', assertion: /x/ },
    }).catch((error: unknown) => void log.push(`check ended: ${String(error).split('\n')[0]}`));
    await vi.waitFor(() => expect(finished).toBe(true), { timeout: 15_000 });
    expect(thirdRan, 'the third run was never started').toBe(false);
    expect(log.some((line) => line.startsWith('check ended: Error: COMMANDS_STOPPED')), 'the third run was refused').toBe(true);
    expect(log.at(-1)).toBe('exit 143');
    expect(log.indexOf('stopped')).toBeLessThan(log.indexOf('rebuild'));
    await vi.waitFor(() => expect(alive(Number(pids[1]))).toBe(false), { timeout: 5000, interval: 25 });
  }, 40_000);
});
