import { createAppStore, type AppStore } from '../app-store.js';
import { SOURCE_REBIND_USAGE, parseRebindArgs } from '../commands.js';
import { ConfigError, parseCommandConfig } from '../config.js';
import { databaseMessage } from '../database-errors.js';
import { MappingError } from '../mapping/diagnostics.js';
import { loadMappingFile } from '../mapping/load.js';
import { identityHashOf } from '../registry/identity-hash.js';
import { fileURLToPath } from 'node:url';

const SHIPPED_MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));
const USAGE_ERROR = 2;
const FAILURE = 1;

export type RebindStore = Pick<AppStore, 'rebindSource' | 'close'>;

export interface RebindIo {
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
  /** Asks the operator to type the source ID again; absent when there is no terminal to ask on. */
  readonly ask?: (question: string) => Promise<string>;
  readonly migrationsDirectory?: string;
  readonly openStore?: (url: string, directory: string) => RebindStore;
}


/**
 * `neburyx source rebind <id> [--confirm <id>]`: after the operator types the source's ID again, sets the stored identity hash of every investigation of that source to the one the source has now.
 * It reads no source and prints no address, login, database name or hash. Exit 0 when done (also when nothing needed rebinding), 1 for a refusal or a failure, 2 for a usage error.
 */
export async function runSourceRebindCommand(args: readonly string[], env: Readonly<Record<string, string | undefined>>, io: RebindIo): Promise<number> {
  const parsed = parseRebindArgs(args);
  if (parsed === undefined) {
    io.stderr.write(SOURCE_REBIND_USAGE);
    return USAGE_ERROR;
  }
  const typed = parsed.confirm ?? (io.ask === undefined ? undefined : await io.ask(`Type the source ID ${parsed.id} again to confirm: `));
  if (typed === undefined) {
    io.stderr.write(`${SOURCE_REBIND_USAGE}no terminal to confirm on: pass --confirm with the source ID\n`);
    return USAGE_ERROR;
  }
  if (typed !== parsed.id) {
    io.stderr.write('the confirmation does not match the source ID; nothing was changed\n');
    return USAGE_ERROR;
  }

  let config;
  try {
    config = parseCommandConfig(env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    io.stderr.write(`${error.message}\n`);
    return FAILURE;
  }
  if (config.mappingPath === undefined) {
    io.stderr.write('source rebind needs NEBURYX_CONFIG, the path of the mapping file\n');
    return FAILURE;
  }
  let mapping;
  try {
    mapping = loadMappingFile(config.mappingPath);
  } catch (error) {
    if (!(error instanceof MappingError)) throw error;
    io.stderr.write('the mapping file could not be loaded; neburyx test-source shows why\n');
    return FAILURE;
  }
  const source = mapping.sources.find((candidate) => candidate.id === parsed.id);
  if (source === undefined) {
    io.stderr.write(`no such source: ${parsed.id}\n`);
    return FAILURE;
  }

  const store = (io.openStore ?? ((url, directory) => createAppStore(url, () => undefined, { migrationsDirectory: directory })))(config.databaseUrl, io.migrationsDirectory ?? SHIPPED_MIGRATIONS);
  try {
    const result = await store.rebindSource(source.id, identityHashOf(source));
    switch (result.outcome) {
      case 'unknown-source':
        io.stderr.write(`no such source: ${parsed.id}\n`);
        return FAILURE;
      case 'not-synced':
        io.stderr.write('the database does not hold this connection yet; start the API once so that it syncs the source, then run this again\n');
        return FAILURE;
      case 'not-tested':
        io.stderr.write(`this connection has not been tested; run neburyx test-source --name ${parsed.id} first, then run this again\n`);
        return FAILURE;
      case 'rebound':
        io.stdout.write(`Source: ${source.id}\nInvestigations rebound: ${result.count}\n`);
        return 0;
    }
  } catch (error) {
    // the sentences name nothing of the connection: no address, login, database name or hash
    io.stderr.write(databaseMessage(error) ?? 'the source could not be rebound; nothing was changed\n');
    return FAILURE;
  } finally {
    await store.close();
  }
}
