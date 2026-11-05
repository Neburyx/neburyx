import { spawn } from 'node:child_process';

export interface Finished {
  readonly stdout: string;
  /** The end of what the command wrote to its error output, kept to say why a run gave no report. */
  readonly stderr: string;
  readonly code: number | null;
  /** The signal that ended the command, when one did. */
  readonly signal: NodeJS.Signals | null;
}

const STDERR_KEPT = 4000;

/** Each command is the leader of its own process group, so that stopping it stops what it started (a browser, a server) too. */
const running = new Map<number, Promise<void>>();
let stopping = false;

/** True once the commands have been stopped: no further command is started, so that a protocol that goes on after an interrupt cannot start a run that nothing stops. */
export const isStopping = (): boolean => stopping;

/** Lets commands start again; for the tests, which stop commands more than once. */
export function resumeTracked(): void {
  stopping = false;
}

/** Runs a command to its end and gives its output and how it ended. Both outputs are read as they come, so a command that writes a lot to either never waits on this one. */
export function runTracked(command: string, args: readonly string[], cwd: string, env: Readonly<Record<string, string>> = {}): Promise<Finished> {
  return new Promise((resolve, reject) => {
    if (stopping) {
      reject(new Error('COMMANDS_STOPPED'));
      return;
    }
    const child = spawn(command, [...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...process.env, ...env } });
    const pid = child.pid;
    const out: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => void out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => void (stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_KEPT)));
    const ended = new Promise<void>((done) => {
      child.on('close', (code, signal) => {
        if (pid !== undefined) running.delete(pid);
        done();
        resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr, code, signal });
      });
    });
    child.on('error', (error) => {
      if (pid !== undefined) running.delete(pid);
      reject(error);
    });
    if (pid !== undefined) running.set(pid, ended);
  });
}

/** Stops every command still running, with everything each one started, and gives back once they have all ended. */
export async function stopTracked(): Promise<void> {
  stopping = true;
  const waiting = [...running.entries()].map(([pid, ended]) => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // the group has already gone
    }
    return ended;
  });
  await Promise.all(waiting);
}
