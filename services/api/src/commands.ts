export type Command = 'api' | 'migrate' | 'test-source';

export const USAGE = 'usage: neburyx api | migrate | test-source --name <source>\n';
export const TEST_SOURCE_USAGE = 'usage: neburyx test-source --name <source>\n';

export function parseCommand(args: readonly string[]): Command | undefined {
  const [word] = args;
  if (word === undefined) return 'api';
  return word === 'api' || word === 'migrate' || word === 'test-source' ? word : undefined;
}

/** The source name of `test-source --name <source>`, or undefined for anything else: no name, no value, a repeated flag, an unknown flag or an extra argument. */
export function parseTestSourceArgs(args: readonly string[]): string | undefined {
  const [flag, value, ...rest] = args;
  if (flag !== '--name' || value === undefined || value === '' || value.startsWith('--') || rest.length > 0) return undefined;
  return value;
}
