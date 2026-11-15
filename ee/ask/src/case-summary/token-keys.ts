import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

export const TOKEN_KEY_VARIABLES = { current: 'NEBURYX_SUMMARY_TOKEN_KEY_FILE', previous: 'NEBURYX_SUMMARY_TOKEN_KEY_PREVIOUS_FILE' } as const;

const GROUP_AND_OTHER_BITS = 0o077;
const KEY_TEXT = /^[0-9a-f]{64}\n?$/;
const KEY_FILE_LIMIT = 65;

export interface TokenKey {
  readonly kid: string;
  readonly bytes: Buffer;
}

export interface TokenKeys {
  readonly current: TokenKey;
  readonly previous?: TokenKey;
}

export type TokenKeysRead = { readonly ok: true; readonly keys: TokenKeys | undefined } | { readonly ok: false; readonly problems: readonly string[] };

type Env = Readonly<Record<string, string | undefined>>;

const kidOf = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex').slice(0, 8);

/** One key file: a regular file only its owner can read, holding 64 lowercase hexadecimal characters and at most one newline; a problem names the variable and never the path or any content. */
async function readKeyFile(variable: string, path: string): Promise<{ readonly key: TokenKey } | { readonly problem: string }> {
  if (!path.startsWith('/')) return { problem: `${variable} must be an absolute path` };
  let text: string;
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const found = await handle.stat();
      if (!found.isFile()) return { problem: `${variable}: the path is not a regular file` };
      if ((found.mode & GROUP_AND_OTHER_BITS) !== 0) return { problem: `${variable}: the file can be read by group or others; owner-only access is required (mode 0600)` };
      if (found.size > KEY_FILE_LIMIT) return { problem: `${variable}: the file does not hold a 256-bit key as 64 hexadecimal characters` };
      const buffer = Buffer.alloc(KEY_FILE_LIMIT);
      const { bytesRead } = await handle.read(buffer, 0, KEY_FILE_LIMIT, 0);
      text = buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return { problem: `${variable}: the file cannot be read` };
  }
  if (!KEY_TEXT.test(text)) return { problem: `${variable}: the file does not hold a 256-bit key as 64 hexadecimal characters` };
  const bytes = Buffer.from(text.trim(), 'hex');
  return { key: { kid: kidOf(bytes), bytes } };
}

/** The sealing key of the summary token and, for a rotation, the one before it; none when the current is not named, which leaves the summary unavailable. */
export async function readTokenKeys(env: Env): Promise<TokenKeysRead> {
  const currentPath = env[TOKEN_KEY_VARIABLES.current] === '' ? undefined : env[TOKEN_KEY_VARIABLES.current];
  const previousPath = env[TOKEN_KEY_VARIABLES.previous] === '' ? undefined : env[TOKEN_KEY_VARIABLES.previous];
  if (currentPath === undefined) {
    return previousPath === undefined ? { ok: true, keys: undefined } : { ok: false, problems: [`${TOKEN_KEY_VARIABLES.previous} is set and ${TOKEN_KEY_VARIABLES.current} is not`] };
  }
  const problems: string[] = [];
  const current = await readKeyFile(TOKEN_KEY_VARIABLES.current, currentPath);
  if ('problem' in current) problems.push(current.problem);
  const previous = previousPath === undefined ? undefined : await readKeyFile(TOKEN_KEY_VARIABLES.previous, previousPath);
  if (previous !== undefined && 'problem' in previous) problems.push(previous.problem);
  if ('key' in current && previous !== undefined && 'key' in previous && current.key.bytes.equals(previous.key.bytes)) problems.push(`${TOKEN_KEY_VARIABLES.previous} holds the same key as ${TOKEN_KEY_VARIABLES.current}`);
  if (problems.length > 0 || !('key' in current)) return { ok: false, problems };
  return { ok: true, keys: { current: current.key, ...(previous !== undefined && 'key' in previous ? { previous: previous.key } : {}) } };
}
