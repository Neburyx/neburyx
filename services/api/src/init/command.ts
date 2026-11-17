import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { INIT_USAGE, parseInitArgs } from '../commands.js';
import { AppError } from '../errors.js';
import { createSourceGate, type SourceGate, type SourceGateOptions } from '../gate/source-gate.js';
import type { GateLogger } from '../gate/types.js';
import { sourceConnectionSchema } from '../mapping/schema.js';
import { communitySeams } from '../seams/community-seams.js';
import { bareMapping, DEFAULT_CONNECT_WAIT_MS, MAX_CONNECT_WAIT_MS, MIN_CONNECT_WAIT_MS } from './bare-source.js';
import { draftMapping } from './draft.js';
import { readSchema } from './schema-read.js';

const USAGE_ERROR = 2;
const FAILURE = 1;
const DEFAULT_DATABASE = 'neo4j';
const DEFAULT_USERNAME_ENV = 'NEO4J_USERNAME';
const DEFAULT_PASSWORD_ENV = 'NEO4J_PASSWORD';

const NEVER_LOG: GateLogger = { warn: () => undefined };

export interface InitIo {
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
  readonly logger?: GateLogger;
  readonly openSourceGate?: (options: SourceGateOptions) => SourceGate;
}

/**
 * `neburyx init --source <id> --uri <uri> [...]`: reads the schema of the source through the gate's system runner, with the fixed schema templates, and writes a draft mapping
 * with a marker where only the engineer can choose. The connection comes from the flags and the names of environment variables, never from values. Exit codes: 0 a draft was made,
 * 1 it could not be made (the source, the database with no labels, a file that exists), 2 a usage error.
 */
export async function runInitCommand(args: readonly string[], env: Readonly<Record<string, string | undefined>>, io: InitIo): Promise<number> {
  const parsed = parseInitArgs(args);
  if (parsed === undefined) {
    io.stderr.write(INIT_USAGE);
    return USAGE_ERROR;
  }
  const connection = {
    sourceId: parsed.source,
    uri: parsed.uri,
    database: parsed.database ?? DEFAULT_DATABASE,
    usernameEnv: parsed.usernameEnv ?? DEFAULT_USERNAME_ENV,
    passwordEnv: parsed.passwordEnv ?? DEFAULT_PASSWORD_ENV,
    connectWaitMs: parsed.connectWaitMs === undefined ? DEFAULT_CONNECT_WAIT_MS : Number(parsed.connectWaitMs),
  };
  const waitOk = Number.isInteger(connection.connectWaitMs) && connection.connectWaitMs >= MIN_CONNECT_WAIT_MS && connection.connectWaitMs <= MAX_CONNECT_WAIT_MS && /^\d+$/.test(parsed.connectWaitMs ?? '0');
  const valid = sourceConnectionSchema.safeParse({ id: connection.sourceId, uri: connection.uri, database: connection.database, auth: { kind: 'basic', username_env: connection.usernameEnv, password_env: connection.passwordEnv } });
  if (!valid.success || !waitOk) {
    if (!valid.success) for (const issue of valid.error.issues) io.stderr.write(`${issue.path.join('.')} ${issue.message}\n`);
    if (!waitOk) io.stderr.write(`--connect-wait-ms must be a whole number from ${MIN_CONNECT_WAIT_MS} to ${MAX_CONNECT_WAIT_MS}\n`);
    io.stderr.write(INIT_USAGE);
    return USAGE_ERROR;
  }
  if (parsed.out !== undefined && existsSync(parsed.out)) {
    io.stderr.write(`${parsed.out} exists; init does not overwrite a file. Name a file that does not exist.\n`);
    return FAILURE;
  }

  const open = io.openSourceGate ?? createSourceGate;
  const sourceGate = open({ mapping: bareMapping(connection), env, seams: communitySeams(), logger: io.logger ?? NEVER_LOG });
  let read;
  try {
    read = await readSchema(sourceGate.system, connection.sourceId, `init-${randomUUID()}`);
  } catch (error) {
    // the code and the reason of a failure are fixed words, never a value of the source
    const what = error instanceof AppError ? `${error.code}${error.reason === undefined ? '' : ` ${error.reason}`}` : error instanceof Error ? error.name : 'unknown';
    io.stderr.write(`The source could not be read (${what}); try again.\n`);
    return FAILURE;
  } finally {
    await sourceGate.close();
  }
  if (!read.ok) {
    io.stderr.write(`${read.message}\n`);
    return FAILURE;
  }
  const draft = draftMapping(read.schema, connection);
  if (!draft.ok) {
    io.stderr.write(`${draft.message}\n`);
    return FAILURE;
  }
  if (parsed.out === undefined) io.stdout.write(draft.text);
  else {
    try {
      writeFileSync(parsed.out, draft.text, { flag: 'wx' });
    } catch {
      io.stderr.write(`${parsed.out} could not be written (it may exist); init does not overwrite a file.\n`);
      return FAILURE;
    }
  }
  io.stderr.write(`The draft holds ${draft.markers} places to fill in; replace each ${draft.marker}, then check it with: neburyx test-source --name ${connection.sourceId}\n`);
  if (draft.cut.length > 0) io.stderr.write(`The database has more than the bound of ${draft.cut.join(', ')}; the draft lists only the first of each.\n`);
  return 0;
}
