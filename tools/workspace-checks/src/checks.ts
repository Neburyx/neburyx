import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { ESLint } from 'eslint';
import { repoRoot } from './workspace.js';

const nodeRequire = createRequire(import.meta.url);

export async function lintRuleIds(file: string): Promise<readonly (string | null)[]> {
  const eslint = new ESLint({ cwd: repoRoot, ignore: false });
  const results = await eslint.lintFiles([join(repoRoot, 'tools', 'workspace-checks', 'fixtures', 'lint', file)]);
  return results.flatMap((result) => result.messages.map((message) => message.ruleId));
}

export function typecheck(dir: string): { readonly exitCode: number; readonly output: string } {
  const tsc = nodeRequire.resolve('typescript/bin/tsc');
  const result = spawnSync(process.execPath, [tsc, '--noEmit', '-p', dir], { encoding: 'utf8' });
  return { exitCode: result.status ?? 1, output: result.stdout };
}
