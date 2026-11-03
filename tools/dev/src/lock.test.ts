import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Lock, LockHeld } from './lock.js';

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function folder(): string {
  const made = mkdtempSync(join(tmpdir(), 'dev-lock-'));
  folders.push(made);
  return made;
}

const lockFile = (where: string): string => join(where, 'neburyx-dev.lock');
const ALIVE = new Set<number>();
const alive = (pid: number): boolean => ALIVE.has(pid);

function stale(where: string, repository: string, pid: number, children: number[] = []): void {
  writeFileSync(lockFile(where), JSON.stringify({ repository, pid, children }));
}

describe('the machine-wide lock', () => {
  it('is taken, records the repository and the process, and is removed on release', () => {
    const where = folder();
    const lock = Lock.acquire({ folder: where, repository: '/work/a', pid: 100, alive });
    expect(JSON.parse(readFileSync(lockFile(where), 'utf8'))).toEqual({ repository: '/work/a', pid: 100, children: [] });
    lock.setChildren([101, 102]);
    expect(JSON.parse(readFileSync(lockFile(where), 'utf8')).children).toEqual([101, 102]);
    lock.release();
    expect(existsSync(lockFile(where))).toBe(false);
  });

  it('refuses a second run from another checkout while the first is alive, naming the repository and the process', () => {
    const where = folder();
    ALIVE.add(200);
    stale(where, '/work/other', 200);
    expect(() => Lock.acquire({ folder: where, repository: '/work/mine', pid: 300, alive })).toThrow(/already running for \/work\/other \(process 200\)/);
    ALIVE.delete(200);
  });

  it('refuses when the leader is gone but a recorded child is still alive, naming that child', () => {
    const where = folder();
    ALIVE.add(402);
    stale(where, '/work/other', 400, [401, 402]);
    expect(() => Lock.acquire({ folder: where, repository: '/work/mine', pid: 500, alive })).toThrow(/process 402/);
    ALIVE.delete(402);
  });

  it('replaces a lock whose recorded processes are all gone', () => {
    const where = folder();
    stale(where, '/work/other', 600, [601]);
    const lock = Lock.acquire({ folder: where, repository: '/work/mine', pid: 700, alive });
    expect(JSON.parse(readFileSync(lockFile(where), 'utf8')).pid).toBe(700);
    expect(existsSync(`${lockFile(where)}.takeover`)).toBe(false);
    lock.release();
  });

  it('refuses a lock file it cannot read, naming the file', () => {
    const where = folder();
    writeFileSync(lockFile(where), 'not json');
    expect(() => Lock.acquire({ folder: where, repository: '/work/mine', pid: 800, alive })).toThrow(new RegExp(`${lockFile(where)} cannot be read`));
  });

  it('refuses when a takeover is under way and names the folder to delete if none is', () => {
    const where = folder();
    stale(where, '/work/other', 900);
    mkdirSync(`${lockFile(where)}.takeover`);
    expect(() => Lock.acquire({ folder: where, repository: '/work/mine', pid: 901, alive })).toThrow(/taking over a stale lock.*takeover/);
  });

  it('never removes the live lock of a contender that finished its takeover while another was paused after reading the stale lock', () => {
    const where = folder();
    stale(where, '/work/dead', 1000);
    let first: Lock | undefined;
    ALIVE.add(1002);
    expect(() =>
      Lock.acquire({
        folder: where,
        repository: '/work/b',
        pid: 1001,
        alive,
        beforeTakeover: () => {
          first = Lock.acquire({ folder: where, repository: '/work/a', pid: 1002, alive });
        },
      }),
    ).toThrow(/process 1002/);
    expect(first).toBeDefined();
    expect(JSON.parse(readFileSync(lockFile(where), 'utf8')).pid).toBe(1002);
    first?.release();
    ALIVE.delete(1002);
  });

  it('does not release a lock that another run has taken since', () => {
    const where = folder();
    const lock = Lock.acquire({ folder: where, repository: '/work/a', pid: 1100, alive });
    stale(where, '/work/b', 1101);
    lock.release();
    expect(JSON.parse(readFileSync(lockFile(where), 'utf8')).pid).toBe(1101);
  });
});

describe('real processes racing for the lock', () => {
  const contender = join(dirname(fileURLToPath(import.meta.url)), 'testing', 'lock-contender.mjs');

  async function race(where: string, count: number): Promise<string[]> {
    const startFile = join(where, 'go');
    const runs = Array.from({ length: count }, (_unused, index) =>
      new Promise<string>((resolve) => {
        const child = spawn(process.execPath, [contender, where, `/work/${index}`, startFile, '1500'], { stdio: ['ignore', 'pipe', 'ignore'] });
        let output = '';
        child.stdout.on('data', (chunk: Buffer) => {
          output += chunk.toString();
        });
        child.once('close', () => resolve(output.trim()));
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 600));
    writeFileSync(startFile, '');
    return Promise.all(runs);
  }

  it('lets exactly one of three runs take a stale lock', async () => {
    const where = folder();
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
    stale(where, '/work/dead', Number(dead.stdout.toString()));
    const outcomes = await race(where, 3);
    expect(outcomes.filter((outcome) => outcome === 'acquired')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'refused')).toHaveLength(2);
  }, 30_000);

  it('lets exactly one of two runs take a lock that is not there (an up and a down, or two downs)', async () => {
    const outcomes = await race(folder(), 2);
    expect(outcomes.sort()).toEqual(['acquired', 'refused']);
  }, 30_000);
});
