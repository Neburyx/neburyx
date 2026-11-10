import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { EXPORT_FILE_MODE } from './directory.js';

/** A file being written carries this prefix until it is renamed, so a crash leaves nothing that looks like a finished export. */
export const TEMPORARY_PREFIX = '.writing-';

const STORAGE_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface StoredExportFile {
  /** Relative to the export directory: the export's ID, nothing else. */
  readonly storageKey: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface ExportFileStore {
  write(id: string, bytes: Uint8Array): Promise<StoredExportFile>;
  /** The file's bytes, or `undefined` when it is not there; a key that is not an export ID is refused before anything is opened. */
  read(storageKey: string): Promise<Buffer | undefined>;
  /** Deletes the file; one that is already gone is not an error. */
  remove(storageKey: string): Promise<void>;
  /** The names of the finished files in the directory. */
  list(): Promise<readonly string[]>;
  /** Deletes the temporary files older than `olderThanMs` and answers how many. */
  sweepTemporary(olderThanMs: number, now?: number): Promise<number>;
}

export function isStorageKey(value: string): boolean {
  return STORAGE_KEY.test(value);
}

function required(key: string): string {
  if (!isStorageKey(key)) throw new Error('not an export storage key');
  return key;
}

const isMissing = (error: unknown): boolean => typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';

export function createExportFileStore(directory: string): ExportFileStore {
  const pathOf = (name: string): string => join(directory, name);

  return {
    async write(id, bytes) {
      const storageKey = required(id);
      const temporary = pathOf(`${TEMPORARY_PREFIX}${storageKey}`);
      try {
        const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, EXPORT_FILE_MODE);
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, pathOf(storageKey));
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
      return { storageKey, sizeBytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
    },

    async read(storageKey) {
      const path = pathOf(required(storageKey));
      try {
        const stat = await lstat(path);
        if (!stat.isFile()) return undefined;
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          return await handle.readFile();
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
      }
    },

    async remove(storageKey) {
      try {
        await unlink(pathOf(required(storageKey)));
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    },

    async list() {
      return (await readdir(directory)).filter((name) => isStorageKey(name));
    },

    async sweepTemporary(olderThanMs, now = Date.now()) {
      let removed = 0;
      for (const name of await readdir(directory)) {
        if (!name.startsWith(TEMPORARY_PREFIX)) continue;
        try {
          const stat = await lstat(pathOf(name));
          if (now - stat.mtimeMs < olderThanMs) continue;
          await unlink(pathOf(name));
          removed += 1;
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      }
      return removed;
    },
  };
}
