import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportDirectoryProblem } from './directory.js';

const scratch = () => mkdtempSync(join(tmpdir(), 'nbx-export-dir-'));

describe('the export directory check', () => {
  it('creates a missing directory with mode 0700', () => {
    const directory = join(scratch(), 'nested', 'exports');
    expect(exportDirectoryProblem(directory)).toBeUndefined();
    expect(statSync(directory).mode & 0o777).toBe(0o700);
  });

  it('accepts a directory that exists with mode 0700', () => {
    const directory = join(scratch(), 'exports');
    mkdirSync(directory, { mode: 0o700 });
    expect(exportDirectoryProblem(directory)).toBeUndefined();
  });

  it.each([0o755, 0o750, 0o707])('refuses a directory with the looser mode %o', (mode) => {
    const directory = join(scratch(), 'exports');
    mkdirSync(directory);
    chmodSync(directory, mode);
    expect(exportDirectoryProblem(directory)).toMatch(/mode must be 0700/);
  });

  it('refuses a path that is a file', () => {
    const file = join(scratch(), 'exports');
    writeFileSync(file, 'x');
    expect(exportDirectoryProblem(file)).toBeDefined();
  });

  it('refuses a directory this process cannot write', () => {
    const directory = join(scratch(), 'exports');
    mkdirSync(directory);
    chmodSync(directory, 0o500);
    expect(exportDirectoryProblem(directory)).toBeDefined();
  });

  it('does not name the path in what it reports', () => {
    const directory = join(scratch(), 'exports');
    writeFileSync(directory, 'x');
    expect(exportDirectoryProblem(directory)).not.toContain(directory);
  });
});
