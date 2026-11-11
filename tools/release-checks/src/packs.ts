import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** The domain packs of the checkout: every folder of `domain-packs` that holds a mapping. */
export function packNames(repoRoot: string): readonly string[] {
  const folder = join(repoRoot, 'domain-packs');
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(folder, entry.name, 'neburyx.yaml')))
    .map((entry) => entry.name)
    .sort();
}
