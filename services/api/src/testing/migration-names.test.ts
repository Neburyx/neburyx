import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { shippedMigrationNames, shippedMigrationRows } from './migration-names.js';

const folders: string[] = [];

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function folderWith(files: readonly string[]): string {
  const folder = mkdtempSync(join(tmpdir(), 'migration-names-'));
  folders.push(folder);
  for (const file of files) writeFileSync(join(folder, file), 'SELECT 1;');
  return folder;
}

describe('the names of a migrations folder', () => {
  it('throws for a folder with no .sql file, so no test runs against an empty expectation', () => {
    expect(() => shippedMigrationNames(folderWith(['README.md']))).toThrow('holds no .sql file');
  });

  it('throws for a folder that does not exist', () => {
    expect(() => shippedMigrationNames(join(tmpdir(), 'migration-names-missing-folder'))).toThrow();
  });

  it('lists only the .sql files, without the suffix, in ascending order', () => {
    const folder = folderWith(['0002-b.sql', 'README.md', '0001-a.sql', '0010-c.sql']);
    expect(shippedMigrationNames(folder)).toEqual(['0001-a', '0002-b', '0010-c']);
    expect(shippedMigrationRows(folder)).toEqual([{ name: '0001-a' }, { name: '0002-b' }, { name: '0010-c' }]);
  });

  it('picks up a file added after an earlier call, last in the list', () => {
    const folder = folderWith(['0001-a.sql']);
    expect(shippedMigrationNames(folder)).toEqual(['0001-a']);
    writeFileSync(join(folder, '0099-extra.sql'), 'SELECT 1;');
    expect(shippedMigrationNames(folder)).toEqual(['0001-a', '0099-extra']);
  });

  it('reads the shipped folder, which starts with the baseline', () => {
    expect(shippedMigrationNames()[0]).toBe('0001-baseline');
  });
});
