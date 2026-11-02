import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const PACKS_FOLDER = join(repositoryRoot, 'domain-packs');

const PACK_NAME = /^[a-z0-9][a-z0-9-]*$/;

export class PackNameError extends Error {}

export interface PackFiles {
  readonly name: string;
  readonly mapping: string;
  readonly definition: string;
}

export function packFiles(name: string, folder = PACKS_FOLDER): PackFiles {
  if (!PACK_NAME.test(name)) throw new PackNameError('a pack name has lower-case letters, digits and hyphens only');
  const directory = join(folder, name);
  if (!existsSync(directory)) throw new PackNameError('there is no such pack');
  return { name, mapping: join(directory, 'neburyx.yaml'), definition: join(directory, 'demo.yaml') };
}

export function listPacks(folder = PACKS_FOLDER): string[] {
  return readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}
