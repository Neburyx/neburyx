export type Command = 'api' | 'migrate';

export const USAGE = 'usage: neburyx api | migrate\n';

export function parseCommand(args: readonly string[]): Command | undefined {
  const [word] = args;
  if (word === undefined) return 'api';
  return word === 'api' || word === 'migrate' ? word : undefined;
}
