import { spawn } from 'node:child_process';
import type { Exec, ExecRequest, ExecResult } from './types.js';

const KILL_GRACE_MS = 5_000;

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone.
  }
}

/** Runs a program in its own process group so that a timeout or an interrupt stops its children too. */
export function createExec(signal: AbortSignal, baseEnv: Readonly<Record<string, string | undefined>>): Exec {
  return (request: ExecRequest): Promise<ExecResult> =>
    new Promise((resolve) => {
      const chunks: string[] = [];
      let timedOut = false;
      let interrupted = false;
      let settled = false;
      const finish = (result: Omit<ExecResult, 'output' | 'timedOut' | 'interrupted'>): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve({ ...result, output: chunks.join(''), timedOut, interrupted });
      };
      const env = { ...baseEnv, ...request.env };
      const child = spawn(request.command, [...request.args], { cwd: request.cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const stop = (): void => {
        killGroup(child.pid, 'SIGTERM');
        setTimeout(() => killGroup(child.pid, 'SIGKILL'), KILL_GRACE_MS).unref();
      };
      const onAbort = (): void => {
        interrupted = true;
        stop();
      };
      const timer = setTimeout(
        () => {
          timedOut = true;
          stop();
        },
        request.timeoutMs ?? 2 ** 31 - 1,
      );
      if (request.ignoreInterrupt !== true) {
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      }
      child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
      child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
      child.on('error', (error) => finish({ exitCode: null, startError: error.message }));
      child.on('close', (code) => finish({ exitCode: timedOut || interrupted ? null : code }));
    });
}
