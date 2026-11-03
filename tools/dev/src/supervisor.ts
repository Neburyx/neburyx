import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { terminateGroup } from './processes.js';

/** The API checks every source before it listens: up to seven gate deadlines of 10 s, plus the database connection and the migration check. 7 x 10 s + 50 s. */
export const API_READY_TIMEOUT_MS = 7 * 10_000 + 50_000;
const DEFAULT_STOP_GRACE_MS = 5000;
const HEALTH_REQUEST_TIMEOUT_MS = 2000;
const HEALTH_POLL_INTERVAL_MS = 250;
const RESTART_DEBOUNCE_MS = 500;

export interface ChildSpec {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface ApiSpec extends ChildSpec {
  readonly healthUrl: string;
  readonly watch: readonly string[];
  readonly readyTimeoutMs?: number;
  readonly debounceMs?: number;
}

export interface Supervision {
  readonly children: readonly ChildSpec[];
  readonly api: ApiSpec;
  readonly out: (text: string) => void;
  readonly onPids?: (pids: readonly number[]) => void;
  readonly stopRequested: Promise<void>;
  readonly stopGraceMs?: number;
}

class Running {
  readonly exited: Promise<number | null>;
  stopping = false;
  private readonly process: ChildProcess;
  private readonly graceMs: number;

  constructor(spec: ChildSpec, graceMs: number) {
    this.graceMs = graceMs;
    this.process = spawn(spec.command, [...spec.args], { cwd: spec.cwd, env: spec.env, stdio: 'inherit', detached: true });
    this.exited = new Promise((resolve) => {
      this.process.once('error', () => resolve(127));
      this.process.once('close', (code) => resolve(code));
    });
  }

  get pid(): number | undefined {
    return this.process.pid;
  }

  hasExited(): boolean {
    return this.process.exitCode !== null || this.process.signalCode !== null;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.process.pid !== undefined) await terminateGroup(this.process.pid, this.graceMs);
    await this.exited;
  }
}

async function becomesReady(url: string, running: Running, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!running.hasExited() && Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS) });
      if (response.ok) return !running.hasExited();
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS));
  }
  return false;
}

/**
 * Runs the children and the API until the developer stops the command (exit 0) or something fails (exit 1).
 * The API is restarted when a watched folder changes; if it exits by itself after it was ready, it waits for the next change.
 * Whatever goes wrong, every child and everything it started is stopped before this returns.
 */
export async function supervise(options: Supervision): Promise<number> {
  const { out, api } = options;
  const graceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  const running: Running[] = [];
  const ready = new WeakSet<Running>();
  const watchers: FSWatcher[] = [];
  let apiProcess: Running | undefined;
  let finished = false;
  let everReady = false;
  let restart: Promise<void> = Promise.resolve();
  let timer: NodeJS.Timeout | undefined;

  const report = (): void => options.onPids?.([...running, ...(apiProcess === undefined ? [] : [apiProcess])].flatMap((entry) => (entry.pid === undefined ? [] : [entry.pid])));
  const stopEverything = async (): Promise<void> => {
    finished = true;
    clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
    await Promise.all([...running, ...(apiProcess === undefined ? [] : [apiProcess])].map((entry) => entry.stop()));
  };

  return new Promise<number>((resolve, reject) => {
    const fail = (message: string): void => {
      if (finished) return;
      out(message);
      void stopEverything().then(() => resolve(1));
    };
    const crash = (error: unknown): void => {
      if (finished) return;
      void stopEverything().then(() => reject(error));
    };

    const launchApi = async (): Promise<void> => {
      const child = new Running(api, graceMs);
      apiProcess = child;
      report();
      void child.exited.then((code) => {
        if (child.stopping || finished || apiProcess !== child || !ready.has(child)) return;
        out(`${api.name} exited by itself (${code === null ? 'signal' : `exit code ${code}`}); it starts again when a file changes`);
      });
      const isReady = await becomesReady(api.healthUrl, child, api.readyTimeoutMs ?? API_READY_TIMEOUT_MS);
      // a start the supervisor itself stopped (a restart) is not a start that failed; the restart's own start is waited for instead
      if (finished || apiProcess !== child || child.stopping) return;
      if (isReady) {
        everReady = true;
        ready.add(child);
        out(`${api.name} is ready`);
        return;
      }
      if (everReady) out(`${api.name} did not become ready after the change`);
      else fail(`${api.name} did not become ready`);
    };

    const changed = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        restart = restart
          .then(async () => {
            if (finished) return;
            out(`a file changed; restarting ${api.name}`);
            await apiProcess?.stop();
            if (!finished) await launchApi();
          })
          .catch(crash);
      }, api.debounceMs ?? RESTART_DEBOUNCE_MS);
    };

    try {
      for (const spec of options.children) {
        const child = new Running(spec, graceMs);
        running.push(child);
        void child.exited.then((code) => {
          if (!child.stopping) fail(`${spec.name} stopped by itself (${code === null ? 'signal' : `exit code ${code}`}); stopping everything`);
        });
      }
      report();
      for (const folder of api.watch) {
        if (!existsSync(folder)) continue;
        const watcher = watch(folder, { recursive: true }, changed);
        watcher.on('error', () => fail(`watching ${folder} failed; stopping everything`));
        watchers.push(watcher);
      }
      launchApi().catch(crash);
      void options.stopRequested.then(() => {
        if (finished) return;
        void stopEverything().then(() => resolve(0));
      });
    } catch (error) {
      void stopEverything().then(() => reject(error));
    }
  });
}
