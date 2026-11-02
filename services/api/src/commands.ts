export type Command = 'api' | 'migrate' | 'test-source';

export const USAGE = 'usage: neburyx api | migrate | test-source --name <source> [--write-probe]\n';
export const TEST_SOURCE_USAGE = 'usage: neburyx test-source --name <source> [--write-probe]\n';

export function parseCommand(args: readonly string[]): Command | undefined {
  const [word] = args;
  if (word === undefined) return 'api';
  return word === 'api' || word === 'migrate' || word === 'test-source' ? word : undefined;
}

export interface TestSourceArgs {
  readonly name: string;
  readonly writeProbe: boolean;
}

const WRITE_PROBE_FLAG = '--write-probe';

function isName(value: string | undefined): value is string {
  return value !== undefined && value !== '' && !value.startsWith('--');
}

/**
 * The arguments of `test-source --name <source> [--write-probe]`, with the flag before or after the name, or undefined for anything else:
 * no name, no value, a repeated flag, a flag with a value, an unknown flag or an extra argument.
 */
export function parseTestSourceArgs(args: readonly string[]): TestSourceArgs | undefined {
  const [first, second, third, ...rest] = args;
  if (rest.length > 0) return undefined;
  if (first === '--name' && isName(second) && third === undefined) return { name: second, writeProbe: false };
  if (first === '--name' && isName(second) && third === WRITE_PROBE_FLAG) return { name: second, writeProbe: true };
  if (first === WRITE_PROBE_FLAG && second === '--name' && isName(third)) return { name: third, writeProbe: true };
  return undefined;
}
