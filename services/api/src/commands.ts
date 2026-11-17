export type Command = 'api' | 'migrate' | 'test-source' | 'source' | 'init';

export const USAGE = 'usage: neburyx api | migrate | test-source --name <source> [--write-probe] | source rebind <source> [--confirm <source>] | init --source <source> --uri <uri> [--database <name>] [--username-env <name>] [--password-env <name>] [--connect-wait-ms <ms>] [--out <file>]\n';
export const INIT_USAGE = 'usage: neburyx init --source <source> --uri <uri> [--database <name>] [--username-env <name>] [--password-env <name>] [--connect-wait-ms <ms>] [--out <file>]\n';
export const SOURCE_REBIND_USAGE = 'usage: neburyx source rebind <source> [--confirm <source>]\n';
export const TEST_SOURCE_USAGE = 'usage: neburyx test-source --name <source> [--write-probe]\n';

export function parseCommand(args: readonly string[]): Command | undefined {
  const [word] = args;
  if (word === undefined) return 'api';
  return word === 'api' || word === 'migrate' || word === 'test-source' || word === 'source' || word === 'init' ? word : undefined;
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

export interface InitArgs {
  readonly source: string;
  readonly uri: string;
  readonly database?: string;
  readonly usernameEnv?: string;
  readonly passwordEnv?: string;
  readonly connectWaitMs?: string;
  readonly out?: string;
}

const INIT_FLAGS = { '--source': 'source', '--uri': 'uri', '--database': 'database', '--username-env': 'usernameEnv', '--password-env': 'passwordEnv', '--connect-wait-ms': 'connectWaitMs', '--out': 'out' } as const;

/**
 * The arguments of `init --source <id> --uri <uri>` and its optional flags, in any order, or undefined for anything else:
 * a missing `--source` or `--uri`, a flag with no value, a repeated or unknown flag or an extra argument.
 */
export function parseInitArgs(args: readonly string[]): InitArgs | undefined {
  const found: Partial<Record<(typeof INIT_FLAGS)[keyof typeof INIT_FLAGS], string>> = {};
  for (let at = 0; at < args.length; at += 2) {
    const flag = args[at];
    const value = args[at + 1];
    const key = flag === undefined || !Object.hasOwn(INIT_FLAGS, flag) ? undefined : INIT_FLAGS[flag as keyof typeof INIT_FLAGS];
    if (key === undefined || !isName(value) || found[key] !== undefined) return undefined;
    found[key] = value;
  }
  const { source, uri } = found;
  if (source === undefined || uri === undefined) return undefined;
  return { source, uri, ...(found.database === undefined ? {} : { database: found.database }), ...(found.usernameEnv === undefined ? {} : { usernameEnv: found.usernameEnv }), ...(found.passwordEnv === undefined ? {} : { passwordEnv: found.passwordEnv }), ...(found.connectWaitMs === undefined ? {} : { connectWaitMs: found.connectWaitMs }), ...(found.out === undefined ? {} : { out: found.out }) };
}

export interface RebindArgs {
  readonly id: string;
  readonly confirm?: string;
}

/**
 * The arguments that follow `source`: `rebind <source>` or `rebind <source> --confirm <source>` (the flag may come first), or undefined for anything else:
 * another word, no source, a flag with no value, a repeated or unknown flag or an extra argument.
 */
export function parseRebindArgs(args: readonly string[]): RebindArgs | undefined {
  const [word, ...rest] = args;
  if (word !== 'rebind') return undefined;
  if (rest.length === 1 && isName(rest[0])) return { id: rest[0] };
  if (rest.length === 3 && rest[1] === '--confirm' && isName(rest[0]) && isName(rest[2])) return { id: rest[0], confirm: rest[2] };
  if (rest.length === 3 && rest[0] === '--confirm' && isName(rest[1]) && isName(rest[2])) return { id: rest[2], confirm: rest[1] };
  return undefined;
}
