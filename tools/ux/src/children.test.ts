import { describe, expect, it } from 'vitest';
import { runTracked, stopTracked } from './children.ts';

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('the commands of the broken binding check', () => {
  it('does not wait on a command that writes four megabytes to its error output before its report', async () => {
    const finished = await runTracked(process.execPath, ['-e', "process.stderr.write('x'.repeat(4 * 1024 * 1024)); process.stdout.write('{\"ok\":true}')"], process.cwd());
    expect(finished.stdout).toBe('{"ok":true}');
    expect(finished.stderr.length).toBeLessThanOrEqual(4000);
    expect(finished.code).toBe(0);
  }, 20_000);

  it('stops a command with what it started, and gives back once they have ended', async () => {
    const script = "const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' }); process.stdout.write(String(child.pid) + '\\n'); setTimeout(() => {}, 60000);";
    const wait = runTracked(process.execPath, ['-e', script], process.cwd());
    await new Promise((resolve) => setTimeout(resolve, 600));
    await stopTracked();
    const finished = await wait;
    const grandchild = Number(finished.stdout.trim());
    expect(Number.isInteger(grandchild) && grandchild > 0).toBe(true);
    expect(finished.signal).toBe('SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(alive(grandchild)).toBe(false);
  }, 20_000);
});
