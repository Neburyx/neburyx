import { spawn } from 'node:child_process';
import { terminateGroup } from './processes.js';

const CAPTURE_LIMIT_BYTES = 64 * 1024 * 1024;
const STOP_GRACE_MS = 5000;
const CANCELLED = 130;
const NOT_STARTED = 127;

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly show?: boolean;
  readonly signal?: AbortSignal;
}

export type Run = (command: string, args: readonly string[], options?: RunOptions) => Promise<RunResult>;

/** Runs a program with an argument list, never through a shell. A program that cannot start gives code 127, one that was stopped by the signal 130. */
export const run: Run = (command, args, options = {}) =>
  new Promise((resolve) => {
    if (options.signal?.aborted === true) return resolve({ code: CANCELLED, stdout: '', stderr: '' });
    const child = spawn(command, [...args], { cwd: options.cwd, env: options.env, stdio: options.show === true ? 'inherit' : ['ignore', 'pipe', 'pipe'], detached: true });
    let stdout = '';
    let stderr = '';
    let size = 0;
    const collect = (chunk: Buffer, into: 'out' | 'err'): void => {
      size += chunk.length;
      if (size > CAPTURE_LIMIT_BYTES) return;
      if (into === 'out') stdout += chunk.toString();
      else stderr += chunk.toString();
    };
    child.stdout?.on('data', (chunk: Buffer) => collect(chunk, 'out'));
    child.stderr?.on('data', (chunk: Buffer) => collect(chunk, 'err'));
    let cancelled = false;
    const cancel = (): void => {
      cancelled = true;
      if (child.pid !== undefined) void terminateGroup(child.pid, STOP_GRACE_MS);
    };
    options.signal?.addEventListener('abort', cancel, { once: true });
    child.once('error', () => resolve({ code: NOT_STARTED, stdout, stderr }));
    child.once('close', (code) => {
      options.signal?.removeEventListener('abort', cancel);
      resolve({ code: cancelled ? CANCELLED : (code ?? 1), stdout, stderr });
    });
  });

