import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from './exec.js';

const folders: string[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('run', () => {
  it('captures the output and the exit code of a program', async () => {
    expect(await run(process.execPath, ['-e', "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"])).toEqual({ code: 3, stdout: 'out', stderr: 'err' });
  });

  it('gives code 127 for a program that cannot start', async () => {
    expect((await run('/no/such/program', [])).code).toBe(127);
  });

  it('returns 130 without starting the program when the signal is already aborted', async () => {
    const signal = AbortSignal.abort();
    expect((await run(process.execPath, ['-e', 'process.exit(0)'], { signal })).code).toBe(130);
  });

  it('stops the program and a grandchild that ignores the request to stop before it returns when the signal is aborted', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'dev-exec-'));
    folders.push(folder);
    const readyFile = join(folder, 'grandchild-pid');
    const grandchildCode = `process.on('SIGTERM', () => undefined); require('node:fs').writeFileSync(${JSON.stringify(readyFile)}, String(process.pid)); setInterval(() => undefined, 1000);`;
    const parentCode = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchildCode)}], { stdio: 'ignore' }); setInterval(() => undefined, 1000);`;
    const controller = new AbortController();
    const running = run(process.execPath, ['-e', parentCode], { signal: controller.signal, stopGraceMs: 400 });
    cleanups.push(async () => {
      controller.abort();
      await running;
      const leftover = Number(readFileSyncOr(readyFile));
      if (leftover > 0 && alive(leftover)) process.kill(leftover, 'SIGKILL');
    });
    const deadline = Date.now() + 10_000;
    while (!readFileSyncOr(readyFile)) {
      if (Date.now() > deadline) throw new Error('the grandchild did not start');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const grandchild = Number(readFileSyncOr(readyFile));
    expect(alive(grandchild)).toBe(true);
    controller.abort();
    expect((await running).code).toBe(130);
    expect(alive(grandchild)).toBe(false);
  }, 30_000);
});

function readFileSyncOr(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}
