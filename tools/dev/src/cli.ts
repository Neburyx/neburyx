import { ConfigUnusable, withAiConfig } from './config.js';
import { AI_FILE_VARIABLES } from './environments.js';
import { LockHeld } from './lock.js';
import { MappingUnusable } from './mapping.js';
import { StepFailed } from './steps.js';
import { up, type Dependencies } from './up.js';

export const USAGE = 'usage: dev [enterprise]';

export interface CliDependencies extends Dependencies {
  readonly err: (text: string) => void;
}

export async function main(argv: readonly string[], deps: CliDependencies): Promise<number> {
  const enterprise = argv.length === 1 && argv[0] === 'enterprise';
  if (argv.length !== 0 && !enterprise) {
    deps.err(USAGE);
    return 2;
  }
  try {
    // dev:enterprise adds the AI settings file under the shell's own values; plain dev reads only the shell, as before
    return await up(enterprise ? { ...deps, env: withAiConfig(deps.env, deps.files, AI_FILE_VARIABLES) } : deps);
  } catch (error) {
    if (error instanceof LockHeld || error instanceof ConfigUnusable || error instanceof MappingUnusable || error instanceof StepFailed) {
      deps.err(`dev: ${error.message}`);
      return 1;
    }
    deps.err('dev: an unexpected error stopped the command');
    return 1;
  }
}
