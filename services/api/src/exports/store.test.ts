import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { exportFilename } from './filename.js';
import { createExportFileStore, TEMPORARY_PREFIX } from './store.js';

let directory: string;
beforeEach(() => {
  directory = join(mkdtempSync(join(tmpdir(), 'nbx-store-')), 'exports');
  mkdirSync(directory, { mode: 0o700 });
});

describe('the export file store', () => {
  it('writes a file with mode 0600, named by the ID alone, and reports its size and hash', async () => {
    const id = randomUUID();
    const bytes = Buffer.from('{"header":{}}');
    const stored = await createExportFileStore(directory).write(id, bytes);
    expect(stored).toEqual({ storageKey: id, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    expect(readdirSync(directory)).toEqual([id]);
    expect(statSync(join(directory, id)).mode & 0o777).toBe(0o600);
    expect(await createExportFileStore(directory).read(id)).toEqual(bytes);
  });

  it('leaves no file and no temporary file when the write fails, and surfaces the error', async () => {
    const store = createExportFileStore(directory);
    chmodSync(directory, 0o500);
    await expect(store.write(randomUUID(), Buffer.from('x'))).rejects.toThrow();
    chmodSync(directory, 0o700);
    expect(readdirSync(directory)).toEqual([]);
  });

  it('removes the temporary file when the rename cannot happen', async () => {
    const id = randomUUID();
    mkdirSync(join(directory, id));
    writeFileSync(join(directory, id, 'blocker'), 'x');
    await expect(createExportFileStore(directory).write(id, Buffer.from('x'))).rejects.toThrow();
    expect(readdirSync(directory).filter((name) => name.startsWith(TEMPORARY_PREFIX))).toEqual([]);
  });

  it.each(['', '../etc/passwd', '/etc/passwd', 'a/b', '..', '.', 'not-a-uuid', `${randomUUID()}/x`, `${randomUUID()}\u0000`, randomUUID().toUpperCase()])('refuses the storage key %j and opens nothing', async (key) => {
    const store = createExportFileStore(directory);
    await expect(store.read(key)).rejects.toThrow('not an export storage key');
    await expect(store.remove(key)).rejects.toThrow('not an export storage key');
    await expect(store.write(key, Buffer.from('x'))).rejects.toThrow('not an export storage key');
    expect(readdirSync(directory)).toEqual([]);
  });

  it('does not follow a symbolic link, to a file or out of the directory', async () => {
    const outside = join(mkdtempSync(join(tmpdir(), 'nbx-outside-')), 'secret');
    writeFileSync(outside, 'secret');
    const id = randomUUID();
    symlinkSync(outside, join(directory, id));
    expect(await createExportFileStore(directory).read(id)).toBeUndefined();
  });

  it('answers undefined for a file that is gone, and deleting a file twice or a missing file is not an error', async () => {
    const id = randomUUID();
    const store = createExportFileStore(directory);
    expect(await store.read(id)).toBeUndefined();
    await store.write(id, Buffer.from('x'));
    await store.remove(id);
    await store.remove(id);
    expect(existsSync(join(directory, id))).toBe(false);
  });

  it('sweeps temporary files older than the age and leaves the rest', async () => {
    const store = createExportFileStore(directory);
    const old = join(directory, `${TEMPORARY_PREFIX}${randomUUID()}`);
    const fresh = join(directory, `${TEMPORARY_PREFIX}${randomUUID()}`);
    const finished = randomUUID();
    writeFileSync(old, 'x');
    writeFileSync(fresh, 'x');
    await store.write(finished, Buffer.from('x'));
    const longAgo = new Date(Date.now() - 3_600_000);
    utimesSync(old, longAgo, longAgo);
    expect(await store.sweepTemporary(900_000)).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(join(directory, finished))).toBe(true);
  });
});

describe('the download file name', () => {
  it('holds the UTC time and the extension of the format, and nothing else', () => {
    const at = new Date('2026-11-10T10:15:00.123Z');
    expect(exportFilename('json', at)).toBe('neburyx-export-20261110T101500Z.json');
    expect(exportFilename('csv', at)).toBe('neburyx-export-20261110T101500Z.zip');
  });
});
