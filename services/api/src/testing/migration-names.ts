import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SHIPPED_MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url));

export function shippedMigrationNames(directory: string = SHIPPED_MIGRATIONS): readonly string[] {
  const names = readdirSync(directory)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => file.slice(0, -'.sql'.length));
  if (names.length === 0) throw new Error('the migrations folder holds no .sql file');
  return names;
}

export function shippedMigrationRows(directory: string = SHIPPED_MIGRATIONS): readonly { readonly name: string }[] {
  return shippedMigrationNames(directory).map((name) => ({ name }));
}
