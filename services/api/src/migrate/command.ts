import { ConfigError } from '../config.js';
import { parseMigrateConfig } from './config.js';
import { migrate } from './run.js';

export interface MigrateIo {
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
  readonly directory: string;
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

  const outcome = await migrate({ url: config.url, appRole: config.appRole, directory: io.directory });
  switch (outcome.status) {
    case 'done':
      io.stdout.write(outcome.applied.length > 0 ? `applied ${outcome.applied.join(', ')}\n` : 'nothing to apply\n');
      return 0;
    case 'unreachable':
      io.stderr.write('the database could not be reached\n');
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
    case 'queue-step-failed':
      io.stderr.write('the job queue step failed after the application migrations were applied; run the command again\n');
      return 1;
    case 'failed':
      io.stderr.write('the migration run failed\n');
      return 1;
  }
}
