import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseDocument, stringify } from 'yaml';
import { z } from 'zod';
import { PACKS_FOLDER, packFiles } from './packs.js';
import { PresetError, readPreset } from './preset.js';

export class CombineError extends Error {}

const sourceEntry = z.record(z.string(), z.unknown());

function entityTypesOf(entry: Record<string, unknown>): readonly unknown[] {
  const { entities } = entry;
  return Array.isArray(entities) ? entities.map((entity: unknown) => (typeof entity === 'object' && entity !== null && 'type' in entity ? entity.type : undefined)) : [];
}

/** Adds the pack's preset as the source's `demo_case`, the one place the preset is written being its `cases.yaml`. */
function withDemoCase(pack: string, entry: Record<string, unknown>, casesFile: string): Record<string, unknown> {
  if ('demo_case' in entry) throw new CombineError(`pack ${pack} holds a demo_case in its mapping; its preset is written in its cases file only`);
  let preset;
  try {
    preset = readPreset(casesFile);
  } catch (error) {
    if (error instanceof PresetError) throw new CombineError(`pack ${pack}: ${error.message}`);
    throw error;
  }
  if (preset === undefined) return entry;
  if (entry['synthetic'] !== true) throw new CombineError(`pack ${pack}: the preset needs synthetic: true on the pack's source`);
  if (!entityTypesOf(entry).includes(preset.entity.type)) throw new CombineError(`pack ${pack}: the preset names an entity type the pack's mapping does not have`);
  return { ...entry, demo_case: preset };
}

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
  return { id, entry: withDemoCase(pack, entry.data, packFiles(pack, folder).cases) };
}

const LOOPBACK_BOLT = /^bolt:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d{1,5})$/;
const MAX_PORT = 65535;

function isLoopbackBolt(address: string): boolean {
  const port = Number(LOOPBACK_BOLT.exec(address)?.[1]);
  return port >= 1 && port <= MAX_PORT;
}

const ASK_FILES = ['classification.md', 'intents.json'];
const OPTIONAL_ASK_FILES = ['typologies.md'];
/** A file that marks an `ask/` folder as one this command wrote (the loader ignores names that start with a dot), so an operator's own folder is never replaced or removed. */
const WRITTEN_MARK = '.written-by-combine';

function checkOwnFolder(target: string): void {
  if (existsSync(target) && !existsSync(join(target, WRITTEN_MARK))) throw new CombineError(`${target} exists and was not written by this command; it is left as it was`);
}

/** The pack's Ask folder, which holds its two files and the optional typology text, all plain files; any other entry is refused, since the product's start-up would stop on it. */
function askFolderOf(pack: string, folder: string): string {
  const path = join(folder, pack, 'ask');
  if (!existsSync(path)) throw new CombineError(`pack ${pack} has no ask folder`);
  const entries = readdirSync(path, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  if (entries.some((entry) => !entry.isFile()) || !ASK_FILES.every((name) => names.includes(name)) || names.some((name) => ![...ASK_FILES, ...OPTIONAL_ASK_FILES].includes(name))) throw new CombineError(`the ask folder of pack ${pack} must hold ${ASK_FILES.join(' and ')} and may hold ${OPTIONAL_ASK_FILES.join(' and ')}, as plain files`);
  return path;
}

export interface CombineOptions {
  /** Write `ai: { preview: true }` and copy each pack's Ask folder to `ask/<source id>/` beside the output file. */
  readonly ask?: boolean;
}

export function combinePacks(packs: readonly string[], out: string, folder = PACKS_FOLDER, addresses: ReadonlyMap<string, string> = new Map(), options: CombineOptions = {}): void {
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
  checkOwnFolder(join(dirname(out), 'ask'));
  const askFolders = options.ask === true ? found.map((entry) => ({ id: entry.id, path: askFolderOf(entry.pack, folder) })) : [];
  mkdirSync(dirname(out), { recursive: true });
  const suffix = randomBytes(6).toString('hex');
  const temporary = join(dirname(out), `.combine-${suffix}`);
  const temporaryAsk = join(dirname(out), `.combine-ask-${suffix}`);
  try {
    if (options.ask === true) {
      for (const entry of askFolders) cpSync(entry.path, join(temporaryAsk, entry.id), { recursive: true });
      writeFileSync(join(temporaryAsk, WRITTEN_MARK), '');
    }
    writeFileSync(temporary, stringify(options.ask === true ? { ai: { preview: true }, sources } : { sources }, { aliasDuplicateObjects: false }));
    rmSync(join(dirname(out), 'ask'), { recursive: true, force: true });
    if (options.ask === true) renameSync(temporaryAsk, join(dirname(out), 'ask'));
    renameSync(temporary, out);
  } catch (error) {
    rmSync(temporary, { force: true });
    rmSync(temporaryAsk, { recursive: true, force: true });
    throw error;
  }
}

