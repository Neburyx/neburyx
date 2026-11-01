import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { configurationFilesIn, containsText, extractLayers } from './scan.js';

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function folder(): string {
  const root = mkdtempSync(join(tmpdir(), 'scan-test-'));
  roots.push(root);
  return root;
}

function savedImage(layers: Readonly<Record<string, string>>): string {
  const saved = folder();
  mkdirSync(join(saved, 'blobs'));
  const names: string[] = [];
  for (const [name, content] of Object.entries(layers)) {
    const source = folder();
    writeFileSync(join(source, name), content);
    execFileSync('tar', ['-cf', join(saved, 'blobs', `${name}.tar`), '-C', source, name]);
    names.push(`blobs/${name}.tar`);
  }
  writeFileSync(join(saved, 'manifest.json'), JSON.stringify([{ Config: 'c', RepoTags: [], Layers: names }]));
  return saved;
}

describe('containsText', () => {
  it('finds text in a file and reports a clean folder as clean', async () => {
    const dirty = folder();
    writeFileSync(join(dirty, 'a.txt'), 'before needle after');
    const clean = folder();
    writeFileSync(join(clean, 'a.txt'), 'nothing here');
    expect(await containsText(dirty, 'needle')).toBe(true);
    expect(await containsText(clean, 'needle')).toBe(false);
  });

  it('fails instead of reporting a clean folder when the search itself fails', async () => {
    await expect(containsText(join(folder(), 'missing'), 'needle')).rejects.toThrow();
  });
});

describe('extractLayers', () => {
  it('unpacks every layer listed in the manifest', async () => {
    const saved = savedImage({ first: 'one', second: 'two' });
    const into = folder();
    const layers = await extractLayers(saved, into);
    expect(layers).toHaveLength(2);
    expect(await containsText(layers[0] ?? '', 'one')).toBe(true);
    expect(await containsText(layers[1] ?? '', 'two')).toBe(true);
  });

  it('fails when a layer cannot be unpacked', async () => {
    const saved = savedImage({ first: 'one' });
    writeFileSync(join(saved, 'blobs', 'first.tar'), 'not a tar archive');
    await expect(extractLayers(saved, folder())).rejects.toThrow();
  });

  it('fails when the manifest lists no image', async () => {
    const saved = folder();
    writeFileSync(join(saved, 'manifest.json'), '[]');
    await expect(extractLayers(saved, folder())).rejects.toThrow();
  });
});

describe('configurationFilesIn', () => {
  it('lists neburyx.yaml and .env files at any depth and nothing else', () => {
    const root = folder();
    mkdirSync(join(root, 'etc', 'app'), { recursive: true });
    for (const name of ['neburyx.yaml', '.env', 'etc/app/.env.local', 'etc/app/neburyx.yaml', 'etc/app/other.yaml', 'environment']) {
      writeFileSync(join(root, name), '');
    }
    expect([...configurationFilesIn(root)].sort()).toEqual(['.env', 'etc/app/.env.local', 'etc/app/neburyx.yaml', 'neburyx.yaml']);
  });
});
