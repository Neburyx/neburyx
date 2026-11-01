import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

const run = promisify(execFile);
const execFailure = z.object({ code: z.number().optional(), stdout: z.string().optional(), stderr: z.string().optional() });

export interface DockerResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export async function docker(args: readonly string[]): Promise<DockerResult> {
  try {
    const { stdout, stderr } = await run('docker', [...args], { maxBuffer: 256 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = execFailure.safeParse(error);
    if (!failure.success) throw error;
    return { code: failure.data.code ?? 1, stdout: failure.data.stdout ?? '', stderr: failure.data.stderr ?? '' };
  }
}

export async function dockerOk(args: readonly string[]): Promise<string> {
  const result = await docker(args);
  if (result.code !== 0) throw new Error(`docker ${args.slice(0, 2).join(' ')} failed (${result.code}): ${result.stderr.slice(-2000)}`);
  return result.stdout.trim();
}

export function dockerStream(args: readonly string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', [...args], { cwd, stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`docker ${args[0]} failed (${code})`))));
  });
}
