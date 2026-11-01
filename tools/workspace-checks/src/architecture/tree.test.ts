import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadTree } from './tree.js';

const created: string[] = [];

function tempRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'tree-'));
  created.push(root);
  return root;
}

afterEach(() => {
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('loadTree', () => {
  it.each(['a.ts', 'a.tsx', 'a.mts', 'a.cts', 'a.js', 'a.jsx', 'a.mjs', 'a.cjs'])('finds a file named %s', (name) => {
    const root = tempRepo();
    mkdirSync(join(root, 'services'));
    writeFileSync(join(root, 'services', name), 'export {};');
    expect(loadTree(root, { include: ['services'] }).map((file) => file.path)).toEqual([`services/${name}`]);
  });

  it('skips other files, node_modules, dist and the excluded paths', () => {
    const root = tempRepo();
    for (const dir of ['services/node_modules', 'services/dist', 'services/skipped', 'services/kept']) mkdirSync(join(root, dir), { recursive: true });
    for (const file of ['services/node_modules/a.ts', 'services/dist/a.ts', 'services/skipped/a.ts', 'services/kept/a.ts', 'services/readme.md']) {
      writeFileSync(join(root, file), 'export {};');
    }
    expect(loadTree(root, { include: ['services'], exclude: ['services/skipped'] }).map((file) => file.path)).toEqual(['services/kept/a.ts']);
  });

  it('does not follow symbolic links', () => {
    const root = tempRepo();
    mkdirSync(join(root, 'services'));
    mkdirSync(join(root, 'outside'));
    writeFileSync(join(root, 'outside', 'a.ts'), 'export {};');
    symlinkSync(join(root, 'outside'), join(root, 'services', 'link'));
    expect(loadTree(root, { include: ['services'] })).toEqual([]);
  });

  it('skips a requested directory the repository does not have', () => {
    const root = tempRepo();
    mkdirSync(join(root, 'services'));
    writeFileSync(join(root, 'services', 'a.ts'), 'export {};');
    expect(loadTree(root, { include: ['apps', 'services'] }).map((file) => file.path)).toEqual(['services/a.ts']);
  });

  it('skips a symbolic link given as a requested directory', () => {
    const root = tempRepo();
    mkdirSync(join(root, 'outside'));
    writeFileSync(join(root, 'outside', 'a.ts'), 'export {};');
    symlinkSync(join(root, 'outside'), join(root, 'services'));
    expect(loadTree(root, { include: ['services'] })).toEqual([]);
  });

  it('throws when a requested directory cannot be looked at because its parent is not accessible', () => {
    const root = tempRepo();
    const parent = join(root, 'parent');
    mkdirSync(join(parent, 'child'), { recursive: true });
    chmodSync(parent, 0o000);
    try {
      expect(() => loadTree(root, { include: ['parent/child'] })).toThrow();
    } finally {
      chmodSync(parent, 0o755);
    }
  });

  it('skips a requested path whose parent is a file', () => {
    const root = tempRepo();
    writeFileSync(join(root, 'services'), 'not a folder');
    expect(loadTree(root, { include: ['services/child'] })).toEqual([]);
  });

  it('throws when a file under a requested directory cannot be read', () => {
    const root = tempRepo();
    mkdirSync(join(root, 'services'));
    const file = join(root, 'services', 'a.ts');
    writeFileSync(file, 'export {};');
    chmodSync(file, 0o000);
    try {
      expect(() => loadTree(root, { include: ['services'] })).toThrow();
    } finally {
      chmodSync(file, 0o644);
    }
  });
});
