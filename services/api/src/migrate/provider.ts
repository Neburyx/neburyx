import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { sql } from 'kysely';
import type { Migration, MigrationProvider } from 'kysely/migration';

export async function migrationFileNames(directory: string): Promise<readonly string[]> {
  return (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort().map((file) => basename(file, '.sql'));
}

/**
 * The files of the image, plus a stand-in that does nothing for each name the database has applied and the
 * image does not ship (the state after rolling the image back). Kysely refuses a history it cannot find
 * every name of; the stand-ins give it a complete list, and they never run because their names are applied.
 */
export function sqlFileProvider(directory: string, appliedElsewhere: readonly string[] = []): MigrationProvider {
  return {
    async getMigrations(): Promise<Record<string, Migration>> {
      const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
      const migrations: Record<string, Migration> = {};
      for (const file of files) {
        const text = await readFile(join(directory, file), 'utf8');
        migrations[basename(file, '.sql')] = {
          async up(db) {
            await sql.raw(text).execute(db);
          },
        };
      }
      for (const name of appliedElsewhere) {
        migrations[name] ??= { async up() {} };
      }
      return migrations;
    },
  };
}
