import { resolve } from 'node:path';
import { ConfigError } from '../config.js';
import { unreachableMessage } from '../db/connect-timeout.js';
import { MappingError } from '../mapping/diagnostics.js';
import { loadMappingFile } from '../mapping/load.js';
import type { MappingModel } from '../mapping/model.js';
import { loadProfileExtension, registeredExtensionLoader, type ExtensionLoader } from '../profile/extension.js';
import { decidePreviewSwitch, previewInputsOf } from '../profile/switch.js';
import { parseMigrateConfig } from './config.js';
import { migrate } from './run.js';

export interface MigrateIo {
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
  readonly directory: string;
  /** The loader of the enterprise extension; the registered one unless a test names its own. */
  readonly extensionLoader?: ExtensionLoader;
}

export async function runMigrateCommand(env: Readonly<Record<string, string | undefined>>, io: MigrateIo): Promise<number> {
  let config;
  try {
    config = parseMigrateConfig(env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    io.stderr.write(`${error.message}\n`);
    return 1;
  }

  let mapping: MappingModel = { sources: [] };
  const mappingPath = env['NEBURYX_CONFIG'];
  if (mappingPath !== undefined && mappingPath !== '') {
    try {
      mapping = loadMappingFile(resolve(mappingPath));
    } catch (error) {
      if (!(error instanceof MappingError)) throw error;
      io.stderr.write(`${error.message}\n`);
      return 1;
    }
  }

  let decision;
  try {
    decision = decidePreviewSwitch(previewInputsOf(env, mapping));
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    io.stderr.write(`${error.message}\n`);
    return 1;
  }
  if (decision.state === 'refused') {
    io.stderr.write(`${decision.message}\n`);
    return 1;
  }

  let eeDirectory: string | undefined;
  if (decision.state === 'on') {
    const loaded = await loadProfileExtension(io.extensionLoader ?? registeredExtensionLoader());
    if (!loaded.ok) {
      io.stderr.write(`${loaded.message}\n`);
      return 1;
    }
    eeDirectory = loaded.extension.migrationsDirectory;
  }

  const outcome = await migrate({ url: config.url, appRole: config.appRole, connectTimeoutMs: config.connectTimeoutMs, directory: io.directory, ...(eeDirectory === undefined ? {} : { eeDirectory }) });
  switch (outcome.status) {
    case 'done':
      io.stdout.write(outcome.applied.length > 0 ? `applied ${outcome.applied.join(', ')}\n` : 'nothing to apply\n');
      return 0;
    case 'unreachable':
      io.stderr.write(`${unreachableMessage(outcome.cause)}\n`);
      return 1;
    case 'unknown-role':
      io.stderr.write('invalid configuration: DATABASE_APP_ROLE names no existing role\n');
      return 1;
    case 'migration-failed':
      io.stderr.write(`migration ${outcome.file} failed; nothing from this run was applied\n`);
      return 1;
    case 'out-of-order':
      io.stderr.write(`migration ${outcome.file} sorts before a migration that was already applied; give a new migration a later name\n`);
      return 1;
    case 'ee-migration-failed':
      io.stderr.write(`enterprise migration ${outcome.file} failed; the application migrations and the job queue step of this run are applied, and the enterprise migrations of earlier runs are kept\n`);
      return 1;
    case 'ee-failed':
      io.stderr.write('the enterprise migration step failed; the application migrations and the job queue step of this run are applied, and the enterprise migrations of earlier runs are kept; run the command again after fixing the cause\n');
      return 1;
    case 'ee-out-of-order':
      io.stderr.write(`enterprise migration ${outcome.file} sorts before an enterprise migration that was already applied; give a new migration a later name\n`);
      return 1;
    case 'queue-step-failed':
      io.stderr.write('the job queue step failed after the application migrations were applied; run the command again\n');
      return 1;
    case 'failed':
      io.stderr.write('the migration run failed\n');
      return 1;
  }
}
