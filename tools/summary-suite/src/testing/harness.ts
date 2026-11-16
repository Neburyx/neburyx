import { runCli } from '../eval/cli.js';
import type { EvalHooks } from '../eval/hooks.js';
import { realHooks } from './eval-hooks.js';
import type { ModelProvider } from '@neburyx/ee-ask';

export async function cli(args: readonly string[], env: Record<string, string> = {}, hooks: EvalHooks<ModelProvider> = realHooks, signal?: AbortSignal) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(args, { out: (line) => void out.push(line), err: (line) => void err.push(line), env, ...(signal === undefined ? {} : { signal }) }, hooks);
  return { code, out, err, text: out.join('\n') };
}
