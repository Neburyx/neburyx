import { StepFailed } from './compose.js';
import { IncompleteExternalDatabase } from './external.js';
import { LockHeld } from './lock.js';
import { IncompleteMapping, MappingUnusable } from './mapping.js';
import { SettingsInvalid, down, up, type Dependencies } from './up.js';

export const USAGE = 'usage: dev (up | down)';

export interface CliDependencies extends Dependencies {
  readonly err: (text: string) => void;
}

export async function main(argv: readonly string[], deps: CliDependencies): Promise<number> {
  const command = argv[0];
  if ((command !== 'up' && command !== 'down') || argv.length !== 1) {
    deps.err(USAGE);
    return 2;
  }
  try {
    return await (command === 'up' ? up(deps) : down(deps));
  } catch (error) {
    if (error instanceof LockHeld || error instanceof SettingsInvalid || error instanceof IncompleteExternalDatabase || error instanceof IncompleteMapping || error instanceof MappingUnusable || error instanceof StepFailed) {
      deps.err(`dev: ${error.message}`);
      return 1;
    }
    deps.err('dev: an unexpected error stopped the command');
    return 1;
  }
}
