import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, watch, type FSWatcher } from 'node:fs';

/** The API checks every source before it listens: up to seven gate deadlines of 10 s, plus the database connection and the migration check. 7 x 10 s + 50 s. */
export const API_READY_TIMEOUT_MS = 7 * 10_000 + 50_000;
const STOP_GRACE_MS = 5000;

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
  /** Resolves when the developer stops the command (Ctrl-C or SIGTERM). */
  readonly stopRequested: Promise<void>;
}

class Running {
  readonly exited: Promise<number | null>;
  stopping = false;

  constructor(
    readonly spec: ChildSpec,
    readonly process: ChildProcess,
  ) {
    this.exited = new Promise((resolve) => {
      process.once('error', () => resolve(127));
      process.once('close', (code) => resolve(code));
    });
  }

  get pid(): number | undefined {
    return this.process.pid;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.process.exitCode !== null || this.process.signalCode !== null) return;
    this.process.kill('SIGTERM');
    const timer = setTimeout(() => this.process.kill('SIGKILL'), STOP_GRACE_MS);
    await this.exited;
    clearTimeout(timer);
  }
}

function start(spec: ChildSpec): Running {
  return new Running(spec, spawn(spec.command, [...spec.args], { cwd: spec.cwd, env: spec.env, stdio: 'inherit' }));
}

async function becomesReady(url: string, running: Running, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let exited = false;
  void running.exited.then(() => {
    exited = true;
  });
  while (!exited && Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return true;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

/**
 * Runs the children and the API until the developer stops the command (exit 0) or something fails (exit 1).
 * The API is restarted when a watched folder changes; if it exits by itself after it was ready, it waits for the next change.
 */
export async function supervise(options: Supervision): Promise<number> {
  const { out, api } = options;
  const running: Running[] = [];
  let apiProcess: Running | undefined;
  let finished = false;
  let restart: Promise<void> = Promise.resolve();
  const watchers: FSWatcher[] = [];
  let timer: NodeJS.Timeout | undefined;

  const report = (): void => options.onPids?.([...running, ...(apiProcess === undefined ? [] : [apiProcess])].flatMap((entry) => (entry.pid === undefined ? [] : [entry.pid])));
  const stopEverything = async (): Promise<void> => {
    finished = true;
    clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
    await Promise.all([...running, ...(apiProcess === undefined ? [] : [apiProcess])].map((entry) => entry.stop()));
  };

  const result = new Promise<number>((resolve) => {
    const fail = (message: string): void => {
      if (finished) return;
      out(message);
      void stopEverything().then(() => resolve(1));
    };

    for (const spec of options.children) {
      const child = start(spec);
      running.push(child);
      void child.exited.then((code) => {
        if (!child.stopping) fail(`${spec.name} stopped by itself (${code === null ? 'signal' : `exit code ${code}`}); stopping everything`);
      });
    }

    report();

    let everReady = false;
    const launchApi = async (): Promise<void> => {
      const child = start(api);
      apiProcess = child;
      report();
      void child.exited.then((code) => {
        if (child.stopping || finished || apiProcess !== child) return;
        if (!ready.has(child)) return;
        out(`${api.name} exited by itself (${code === null ? 'signal' : `exit code ${code}`}); it starts again when a file changes`);
      });
      const isReady = await becomesReady(api.healthUrl, child, api.readyTimeoutMs ?? API_READY_TIMEOUT_MS);
      if (finished || apiProcess !== child) return;
      if (isReady) {
        everReady = true;
        ready.add(child);
        out(`${api.name} is ready`);
        return;
      }
      if (everReady) out(`${api.name} did not become ready after the change`);
      else fail(`${api.name} did not become ready`);
    };
    const ready = new Set<Running>();

    const changed = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        restart = restart.then(async () => {
          if (finished) return;
          out(`a file changed; restarting ${api.name}`);
          await apiProcess?.stop();
          if (!finished) await launchApi();
        });
      }, api.debounceMs ?? 500);
    };
    for (const folder of api.watch) {
      if (existsSync(folder)) watchers.push(watch(folder, { recursive: true }, changed));
    }

    void launchApi();
    void options.stopRequested.then(() => {
      if (finished) return;
      void stopEverything().then(() => resolve(0));
    });
  });
  return result;
}
