import { checkRange } from './check.js';

export interface Output {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

export function run(args: readonly string[], cwd: string, output: Output): number {
  const result = checkRange(args, cwd);
  if (result.status === 'pass') {
    output.out(`${result.checked} commit(s) checked, all signed off\n`);
    return 0;
  }
  if (result.status === 'unsigned') {
    const lines = result.unsigned.map((line) => `  ${line}`).join('\n');
    output.err(`Missing Signed-off-by (${result.unsigned.length} of ${result.checked} commits):\n${lines}\nSee CONTRIBUTING.md.\n`);
    return 1;
  }
  output.err(`${result.reason}\nusage: pnpm check:dco <base> <head>\n`);
  return 2;
}
