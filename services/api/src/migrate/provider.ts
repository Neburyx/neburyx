import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { sql } from 'kysely';
import type { Migration, MigrationProvider } from 'kysely/migration';

export function sqlFileProvider(directory: string): MigrationProvider {
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
      return migrations;
    },
  };
}
