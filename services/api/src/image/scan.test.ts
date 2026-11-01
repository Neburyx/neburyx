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

function tarEntry(name: string, mode: number, content: string, type: '0' | '5'): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 'utf8');
  header.write(`${mode.toString(8).padStart(7, '0')}\0`, 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${Buffer.byteLength(content).toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write(type, 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  const sum = [...header].reduce((total, byte) => total + byte, 0);
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  const body = Buffer.alloc(Math.ceil(Buffer.byteLength(content) / 512) * 512);
  body.write(content, 0, 'utf8');
  return Buffer.concat([header, body]);
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

describe('extractLayers with a layer whose folder cannot be entered', () => {
  it('still lets the files in it be searched', async () => {
    const saved = folder();
    mkdirSync(join(saved, 'blobs'));
    const archive = Buffer.concat([tarEntry('locked/', 0o000, '', '5'), tarEntry('locked/secret.txt', 0o000, 'hidden needle', '0'), Buffer.alloc(1024)]);
    writeFileSync(join(saved, 'blobs', 'layer.tar'), archive);
    writeFileSync(join(saved, 'manifest.json'), JSON.stringify([{ Config: 'c', RepoTags: [], Layers: ['blobs/layer.tar'] }]));
    const layers = await extractLayers(saved, folder());
    expect(await containsText(layers[0] ?? '', 'needle')).toBe(true);
    expect(configurationFilesIn(layers[0] ?? '')).toEqual([]);
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
