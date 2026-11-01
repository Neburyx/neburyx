import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

export function runCli(args: readonly string[], env: Readonly<Record<string, string>>): { readonly done: Promise<CliResult> } {
  const child = spawn(process.execPath, [cliPath, ...args], { env: { PATH: process.env['PATH'] ?? '', ...env } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  const done = new Promise<CliResult>((resolve) => child.on('close', (code) => resolve({ code, stdout, stderr })));
  return { done };
}
