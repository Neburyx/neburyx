import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

export class LockHeld extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockHeld';
  }
}

const holderSchema = z.object({ repository: z.string(), pid: z.number(), children: z.array(z.number()) });
type Holder = z.infer<typeof holderSchema>;

export interface LockOptions {
  readonly repository: string;
  readonly pid?: number;
  readonly folder?: string;
  readonly alive?: (pid: number) => boolean;
  /** Called once a contender has read a stale lock and before it takes the takeover guard; tests use it to force an interleaving. */
  readonly beforeTakeover?: () => void;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

function readHolder(path: string): Holder | undefined {
  try {
    const parsed = holderSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export class Lock {
  private readonly path: string;
  private readonly holder: Holder;

  private constructor(path: string, holder: Holder) {
    this.path = path;
    this.holder = holder;
  }

  /** One lock for the machine, because two copies would fight over the same database and the same ports. */
  static acquire(options: LockOptions): Lock {
    const folder = options.folder ?? tmpdir();
    const path = join(folder, 'neburyx-dev.lock');
    const guard = `${path}.takeover`;
    const alive = options.alive ?? isAlive;
    const mine: Holder = { repository: options.repository, pid: options.pid ?? process.pid, children: [] };
    const create = (): boolean => {
      try {
        writeFileSync(path, JSON.stringify(mine), { flag: 'wx', mode: 0o600 });
        return true;
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return false;
        throw error;
      }
    };
    const inspect = (): Holder | undefined => {
      const holder = readHolder(path);
      if (holder === undefined) throw new LockHeld(`the lock file ${path} cannot be read; if no pnpm dev is running, delete it`);
      const running = [holder.pid, ...holder.children].find((pid) => alive(pid));
      if (running !== undefined) throw new LockHeld(`pnpm dev is already running for ${holder.repository} (process ${running}); stop it first`);
      return holder;
    };

    if (create()) return new Lock(path, mine);
    inspect();
    options.beforeTakeover?.();
    try {
      mkdirSync(guard);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw new LockHeld(`another run is taking over a stale lock; if none is, delete the folder ${guard}`);
      throw error;
    }
    try {
      inspect();
      rmSync(path, { force: true });
      if (!create()) throw new LockHeld(`the lock ${path} was taken by another run`);
    } finally {
      rmSync(guard, { recursive: true, force: true });
    }
    return new Lock(path, mine);
  }

  setChildren(children: readonly number[]): void {
    writeFileSync(this.path, JSON.stringify({ ...this.holder, children }), { mode: 0o600 });
  }

  release(): void {
    if (readHolder(this.path)?.pid === this.holder.pid) rmSync(this.path, { force: true });
  }
}
