import { execFile, spawn } from 'node:child_process';

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Show the program's output as it happens instead of capturing it. */
  readonly show?: boolean;
}

export type Run = (command: string, args: readonly string[], options?: RunOptions) => Promise<RunResult>;

/** Runs a program with an argument list, never through a shell. A program that cannot start gives code 127. */
export const run: Run = (command, args, options = {}) =>
  new Promise((resolve) => {
    if (options.show === true) {
      const child = spawn(command, [...args], { cwd: options.cwd, env: options.env, stdio: 'inherit' });
      child.once('error', () => resolve({ code: 127, stdout: '', stderr: '' }));
      child.once('close', (code) => resolve({ code: code ?? 1, stdout: '', stderr: '' }));
      return;
    }
    execFile(command, [...args], { cwd: options.cwd, env: options.env, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 127;
      resolve({ code, stdout, stderr });
    });
  });
