import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dirtyTreeRefusal, recordFolder, renderRecord, resultOf, withExpected, writeRecord, type UpgradeRecord } from './upgrade-record.js';

const COMMIT = 'a'.repeat(40);
const record = (overrides: Partial<UpgradeRecord> = {}): UpgradeRecord => ({
  startedAt: new Date('2026-11-17T03:04:05.678Z'),
  commit: COMMIT,
  dirty: false,
  dryRun: false,
  previous: { reference: 'registry.example/app:1.0.0', digest: 'sha256:' + 'b'.repeat(64), imageId: 'sha256:' + 'c'.repeat(64), migrations: ['0001-a', '0002-b'] },
  build: { reference: 'local-build:t', imageId: 'sha256:' + 'd'.repeat(64), migrations: ['0001-a', '0002-b', '0003-c'] },
  applied: { before: ['0001-a', '0002-b'], after: ['0001-a', '0002-b', '0003-c'] },
  checks: [{ name: 'upgrade keeps the saved work', passed: true }],
  ...overrides,
});

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

describe('the record of an upgrade run', () => {
  it('names both images with the digest of the previous one, and the migrations the build adds', () => {
    const { markdown, json } = renderRecord(record());
    expect(markdown).toContain('registry.example/app:1.0.0');
    expect(markdown).toContain('sha256:' + 'b'.repeat(64));
    expect(markdown).toContain('local-build:t');
    expect(markdown).toContain('Migrations the build adds: 0003-c');
    expect(JSON.parse(json)).toMatchObject({ commit: COMMIT, result: 'PASS', previous: { reference: 'registry.example/app:1.0.0' }, build: { reference: 'local-build:t' } });
  });

  it('has exactly one Commit line of the 40 characters and one Result line', () => {
    const { markdown } = renderRecord(record({ dirty: true, dryRun: true }));
    expect(markdown.split('\n').filter((line) => line.startsWith('Commit: '))).toEqual([`Commit: ${COMMIT}`]);
    expect(markdown.split('\n').filter((line) => line.startsWith('Result: '))).toEqual(['Result: PASS']);
    expect(markdown).toContain('uncommitted changes');
  });

  it('says on its first line whether the run counts, and a dry run is named so', () => {
    expect(renderRecord(record()).markdown.split('\n')[0]).toBe('This run counts toward the release.');
    const dry = renderRecord(record({ dryRun: true }));
    expect(dry.markdown.split('\n')[0]).toBe('Dry run: does not count.');
    expect(dry.name).toBe('20261117T030405Z-aaaaaaa-dry-run');
    expect(renderRecord(record()).name).toBe('20261117T030405Z-aaaaaaa');
  });

  it('fails when a check failed or none ran', () => {
    expect(resultOf([{ name: 'a', passed: true }, { name: 'b', passed: false }])).toBe('FAIL');
    expect(resultOf([])).toBe('FAIL');
    expect(renderRecord(record({ checks: [{ name: 'x', passed: false }] })).markdown).toContain('Result: FAIL');
  });

  it('fills a check that did not run as failed, so a partial run cannot pass', () => {
    const checks = withExpected(['a', 'b'], [{ name: 'a', passed: true }]);
    expect(checks).toEqual([{ name: 'a', passed: true }, { name: 'b', passed: false, note: 'not run' }]);
    const rendered = renderRecord(record({ checks }));
    expect(rendered.result).toBe('FAIL');
    expect(rendered.markdown).toContain('| b | failed (not run) |');
    expect(renderRecord(record()).markdown).toContain('Migrations applied before the upgrade: 2; after: 3');
  });

  it('refuses a dirty tree unless the run is a dry run', () => {
    expect(dirtyTreeRefusal(true, false)).toContain('uncommitted changes');
    expect(dirtyTreeRefusal(true, true)).toBeUndefined();
    expect(dirtyTreeRefusal(false, false)).toBeUndefined();
  });

  it('writes a json and a markdown file with the same name, and refuses a folder inside the repository', () => {
    const folder = mkdtempSync(join(tmpdir(), 'upgrade-record-'));
    folders.push(folder);
    writeRecord(folder, renderRecord(record()));
    expect(readdirSync(folder).sort()).toEqual(['20261117T030405Z-aaaaaaa.json', '20261117T030405Z-aaaaaaa.md']);
    expect(readFileSync(join(folder, '20261117T030405Z-aaaaaaa.md'), 'utf8')).toContain('Result: PASS');
    expect(() => recordFolder('/work/repo/records', '/work/repo')).toThrow('outside the repository');
    expect(() => recordFolder('/work/repo', '/work/repo')).toThrow('outside the repository');
    expect(recordFolder('/work/records', '/work/repo')).toBe('/work/records');
  });
});
