import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ASK_FOLDER_LIMITS, parseIntentsFile, type AskFolder, type AskIntent, type AskSourceFolder, type ConfigureSourceBudgets } from '@neburyx/contracts';

const CLASSIFICATION_FILE = 'classification.md';
const INTENTS_FILE = 'intents.json';
const TYPOLOGY_FILE = 'typologies.md';
const SETTING = 'NEBURYX_ASK_MAPPING_FOLDER';

export type FolderLoad = { readonly ok: true; readonly folder: AskFolder } | { readonly ok: false; readonly problems: readonly string[] };

const sha256Of = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

type Entry = { readonly name: string; readonly kind: 'file' | 'directory' | 'link' | 'other' };

async function entriesOf(path: string): Promise<readonly Entry[] | undefined> {
  try {
    const found = await readdir(path, { withFileTypes: true });
    return found.map((entry) => ({ name: entry.name, kind: entry.isSymbolicLink() ? 'link' : entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other' }));
  } catch {
    return undefined;
  }
}

/** A name from the folder as it may be printed: plain names as they are, any other as a fixed phrase (a name could hold control characters). */
const printable = (name: string): string => (/^[A-Za-z0-9_.-]{1,100}$/.test(name) ? name : '(a name with unusual characters)');

/**
 * Reads one file of at most `limit` bytes, as UTF-8 text with the hash of its bytes. The file is opened without following a link and checked through the handle (a regular file, within the limit) before
 * more than `limit` bytes are read; a problem never holds the file's text.
 */
export async function readText(path: string, label: string, limit: number): Promise<{ readonly text: string; readonly sha256: string } | string> {
  let bytes: Buffer;
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const found = await handle.stat();
      if (!found.isFile()) return `${label}: must be a regular file`;
      if (found.size > limit) return `${label}: the file is larger than ${limit} bytes`;
      const buffer = Buffer.alloc(limit + 1);
      let length = 0;
      for (;;) {
        const read = await handle.read(buffer, length, limit + 1 - length, length);
        if (read.bytesRead === 0) break;
        length += read.bytesRead;
        if (length > limit) return `${label}: the file is larger than ${limit} bytes`;
      }
      bytes = buffer.subarray(0, length);
    } finally {
      await handle.close();
    }
  } catch {
    return `${label}: the file cannot be read`;
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), sha256: sha256Of(bytes) };
  } catch {
    return `${label}: the file is not valid UTF-8 text`;
  }
}

/** An intent of a path search that asks for more than its source allows: the problem names the intent and the setting, with the limit and never a value of a question. */
function pathLimitProblems(file: string, intents: readonly { readonly name: string; readonly kind: string; readonly template?: string; readonly settings?: Readonly<Record<string, unknown>> }[], budgets: ConfigureSourceBudgets): string[] {
  const problems: string[] = [];
  for (const intent of intents) {
    if (intent.kind !== 'template' || intent.template !== 'shortest-paths') continue;
    const hops = intent.settings?.['maxHops'];
    const limit = intent.settings?.['limit'];
    if (typeof hops === 'number' && hops > budgets.maxHops) problems.push(`${file}: intent "${intent.name}": maxHops is above the source's max_hops (${budgets.maxHops})`);
    if (typeof limit === 'number' && limit > Math.min(budgets.pathResultsCap, budgets.maxPage)) problems.push(`${file}: intent "${intent.name}": limit is above the source's path_results_cap or max_page (${Math.min(budgets.pathResultsCap, budgets.maxPage)})`);
  }
  return problems;
}

async function loadSource(folder: string, sourceId: string, problems: string[], budgets?: ConfigureSourceBudgets): Promise<AskSourceFolder | undefined> {
  const where = join(folder, sourceId);
  const entries = await entriesOf(where);
  if (entries === undefined) {
    problems.push(`${SETTING}/${sourceId}: the folder cannot be read`);
    return undefined;
  }
  let usable = true;
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.kind === 'link') {
      problems.push(`${SETTING}/${sourceId}/${printable(entry.name)}: a link is not allowed`);
      usable = false;
    } else if (entry.name !== CLASSIFICATION_FILE && entry.name !== INTENTS_FILE && entry.name !== TYPOLOGY_FILE) {
      problems.push(`${SETTING}/${sourceId}/${printable(entry.name)}: not a file of an Ask folder (${CLASSIFICATION_FILE}, ${INTENTS_FILE} and the optional ${TYPOLOGY_FILE})`);
      usable = false;
    } else if (entry.kind !== 'file') {
      problems.push(`${SETTING}/${sourceId}/${printable(entry.name)}: must be a regular file`);
      usable = false;
    }
  }
  for (const required of [CLASSIFICATION_FILE, INTENTS_FILE]) {
    if (!entries.some((entry) => entry.name === required)) {
      problems.push(`${SETTING}/${sourceId}/${required}: the file is missing`);
      usable = false;
    }
  }
  if (!usable) return undefined;
  const classification = await readText(join(where, CLASSIFICATION_FILE), `${SETTING}/${sourceId}/${CLASSIFICATION_FILE}`, ASK_FOLDER_LIMITS.classificationBytes);
  const intentsText = await readText(join(where, INTENTS_FILE), `${SETTING}/${sourceId}/${INTENTS_FILE}`, ASK_FOLDER_LIMITS.intentsBytes);
  const typology = entries.some((entry) => entry.name === TYPOLOGY_FILE) ? await readText(join(where, TYPOLOGY_FILE), `${SETTING}/${sourceId}/${TYPOLOGY_FILE}`, ASK_FOLDER_LIMITS.classificationBytes) : undefined;
  if (typeof classification === 'string') problems.push(classification);
  if (typeof intentsText === 'string') problems.push(intentsText);
  if (typeof typology === 'string') problems.push(typology);
  if (typeof classification === 'string' || typeof intentsText === 'string' || typeof typology === 'string') return undefined;
  const parsed = parseIntentsFile(intentsText.text);
  if (!parsed.ok) {
    problems.push(...parsed.problems.map((problem) => `${SETTING}/${sourceId}/${INTENTS_FILE}: ${problem}`));
    return undefined;
  }
  if (budgets !== undefined) {
    const found = pathLimitProblems(`${SETTING}/${sourceId}/${INTENTS_FILE}`, parsed.intents, budgets);
    if (found.length > 0) {
      problems.push(...found);
      return undefined;
    }
  }
  const intents: AskIntent[] = parsed.intents.map((intent) => (intent.kind === 'query' ? { name: intent.name, ...(intent.label === undefined ? {} : { label: intent.label }), parameters: intent.parameters, kind: 'query', query: Object.freeze({ text: intent.query, sha256: sha256Of(Buffer.from(intent.query, 'utf8')) }) } : intent));
  return Object.freeze({ classification: Object.freeze({ text: classification.text, sha256: classification.sha256 }), ...(typology === undefined ? {} : { typology: Object.freeze({ text: typology.text, sha256: typology.sha256 }) }), intents: Object.freeze(intents.map((intent) => Object.freeze(intent))) });
}

/**
 * Reads the Ask folder once: `<folder>/<sourceId>/classification.md` and `<folder>/<sourceId>/intents.json` for each configured source that has a subfolder. A source with no subfolder has no entry; a subfolder that is not a source,
 * a link, any other file and a folder with no subfolder for any source (when sources are configured) are problems. Every problem names the setting and the file or intent, never the text of a file.
 */
export async function loadAskFolder(input: { readonly folder: string; readonly sourceIds: readonly string[]; readonly budgets?: Readonly<Record<string, ConfigureSourceBudgets>> }): Promise<FolderLoad> {
  const problems: string[] = [];
  let top;
  try {
    top = await lstat(input.folder);
  } catch {
    return { ok: false, problems: [`${SETTING}: the folder does not exist or cannot be read`] };
  }
  if (!top.isDirectory() && !top.isSymbolicLink()) return { ok: false, problems: [`${SETTING}: the path is not a folder`] };
  const entries = await entriesOf(input.folder);
  if (entries === undefined) return { ok: false, problems: [`${SETTING}: the folder cannot be read`] };
  const sources = new Map<string, AskSourceFolder>();
  const present = new Set<string>();
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (!input.sourceIds.includes(entry.name)) {
      problems.push(`${SETTING}/${printable(entry.name)}: not the id of a configured source`);
    } else if (entry.kind !== 'directory') {
      problems.push(`${SETTING}/${printable(entry.name)}: ${entry.kind === 'link' ? 'a link is not allowed' : 'must be a folder'}`);
    } else {
      present.add(entry.name);
    }
  }
  if (present.size === 0 && input.sourceIds.length > 0 && problems.length === 0) problems.push(`${SETTING}: the folder has no subfolder for any configured source`);
  for (const sourceId of input.sourceIds) {
    if (!present.has(sourceId)) continue;
    const loaded = await loadSource(input.folder, sourceId, problems, input.budgets?.[sourceId]);
    if (loaded !== undefined) sources.set(sourceId, loaded);
  }
  if (problems.length > 0) return { ok: false, problems };
  const ids = Object.freeze([...sources.keys()]);
  const folder: AskFolder = {
    sourceIds: ids,
    source: (sourceId) => sources.get(sourceId),
    intent: (sourceId, name) => sources.get(sourceId)?.intents.find((intent) => intent.name === name),
  };
  return { ok: true, folder: Object.freeze(folder) };
}
