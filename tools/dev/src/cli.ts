import { ConfigUnusable } from './config.js';
import { LockHeld } from './lock.js';
import { MappingUnusable } from './mapping.js';
import { StepFailed } from './steps.js';
import { up, type Dependencies } from './up.js';

export const USAGE = 'usage: dev';

export interface CliDependencies extends Dependencies {
  readonly err: (text: string) => void;
}

export async function main(argv: readonly string[], deps: CliDependencies): Promise<number> {
  if (argv.length !== 0) {
    deps.err(USAGE);
    return 2;
  }
  try {
    return await up(deps);
  } catch (error) {
    if (error instanceof LockHeld || error instanceof ConfigUnusable || error instanceof MappingUnusable || error instanceof StepFailed) {
      deps.err(`dev: ${error.message}`);
      return 1;
    }
    deps.err('dev: an unexpected error stopped the command');
    return 1;
  }
}
