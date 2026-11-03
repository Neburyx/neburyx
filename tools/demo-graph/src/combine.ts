import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseDocument, stringify } from 'yaml';
import { z } from 'zod';
import { PACKS_FOLDER, packFiles } from './packs.js';

export class CombineError extends Error {}

const sourceEntry = z.record(z.string(), z.unknown());

function sourcesOf(pack: string, folder: string): { readonly id: string; readonly entry: Record<string, unknown> } {
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
  const entry = sourceEntry.safeParse(sources[0]);
  const id: unknown = entry.success ? entry.data['id'] : undefined;
  if (!entry.success || typeof id !== 'string' || id === '') throw new CombineError(`the source of pack ${pack} has no ID`);
  return { id, entry: entry.data };
}

const LOOPBACK_BOLT = /^bolt:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d{1,5})$/;
const MAX_PORT = 65535;

function isLoopbackBolt(address: string): boolean {
  const port = Number(LOOPBACK_BOLT.exec(address)?.[1]);
  return port >= 1 && port <= MAX_PORT;
}

export function combinePacks(packs: readonly string[], out: string, folder = PACKS_FOLDER, addresses: ReadonlyMap<string, string> = new Map()): void {
  if (packs.length === 0) throw new CombineError('name at least one pack');
  const found = packs.map((pack) => ({ pack, ...sourcesOf(pack, folder) }));
  const seen = new Set<string>();
  for (const { pack, id } of found) {
    if (seen.has(id)) throw new CombineError(`pack ${pack} repeats a source ID of another pack`);
    seen.add(id);
  }
  for (const [id, address] of addresses) {
    if (!found.some((entry) => entry.id === id)) throw new CombineError(`the source ${id} is not in the packs`);
    if (!isLoopbackBolt(address)) throw new CombineError(`the address for the source ${id} is not a bolt address on a loopback host`);
  }
  const sources = found.map((entry) => {
    const address = addresses.get(entry.id);
    return address === undefined ? entry.entry : { ...entry.entry, uri: address };
  });
  mkdirSync(dirname(out), { recursive: true });
  const temporary = join(dirname(out), `.combine-${randomBytes(6).toString('hex')}`);
  try {
    writeFileSync(temporary, stringify({ sources }, { aliasDuplicateObjects: false }));
    renameSync(temporary, out);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

