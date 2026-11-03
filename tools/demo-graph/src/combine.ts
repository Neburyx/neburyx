import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseDocument, stringify } from 'yaml';
import { PACKS_FOLDER, packFiles } from './packs.js';

export class CombineError extends Error {}

function sourcesOf(pack: string, folder: string): { readonly id: string; readonly entry: unknown } {
  const { mapping } = packFiles(pack, folder);
  let text: string;
  try {
    text = readFileSync(mapping, 'utf8');
  } catch {
    throw new CombineError(`the mapping of pack ${pack} cannot be read`);
  }
  const document = parseDocument(text);
  let data: unknown;
  try {
    data = document.errors.length > 0 ? undefined : document.toJS();
  } catch {
    data = undefined;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new CombineError(`the mapping of pack ${pack} is not a YAML mapping`);
  const keys = Object.keys(data);
  const sources: unknown = 'sources' in data ? data.sources : undefined;
  if (keys.length !== 1 || !Array.isArray(sources) || sources.length !== 1) throw new CombineError(`the mapping of pack ${pack} must hold only a list of sources with exactly one source`);
  const entry: unknown = sources[0];
  const id: unknown = typeof entry === 'object' && entry !== null && 'id' in entry ? entry.id : undefined;
  if (typeof id !== 'string' || id === '') throw new CombineError(`the source of pack ${pack} has no ID`);
  return { id, entry };
}

export function combinePacks(packs: readonly string[], out: string, folder = PACKS_FOLDER): void {
  if (packs.length === 0) throw new CombineError('name at least one pack');
  const found = packs.map((pack) => ({ pack, ...sourcesOf(pack, folder) }));
  const seen = new Set<string>();
  for (const { pack, id } of found) {
    if (seen.has(id)) throw new CombineError(`pack ${pack} repeats a source ID of another pack`);
    seen.add(id);
  }
  mkdirSync(dirname(out), { recursive: true });
  const temporary = join(dirname(out), `.combine-${randomBytes(6).toString('hex')}`);
  try {
    writeFileSync(temporary, stringify({ sources: found.map((entry) => entry.entry) }, { aliasDuplicateObjects: false }));
    renameSync(temporary, out);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

