import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { runCli } from './cli.js';
import { CombineError, combinePacks } from './combine.js';
import { listPacks, packFiles } from './packs.js';
import { scratch } from './testing/export-helpers.js';

const SHIPPED = ['banking-fraud', 'insurance-claims'];

function pack(folder: string, name: string, text: string): void {
  mkdirSync(join(folder, name), { recursive: true });
  writeFileSync(join(folder, name, 'neburyx.yaml'), text);
}

function source(id: string): string {
  return `sources:\n  - id: ${id}\n    uri: "bolt://${id}-graph:7687"\n    synthetic: true\n`;
}

function run(argv: string[], packsFolder?: string) {
  const out: string[] = [];
  const err: string[] = [];
  return runCli(argv, { out: (text) => out.push(text), err: (text) => err.push(text), env: {}, ...(packsFolder === undefined ? {} : { packsFolder }) }).then((code) => ({ code, out, err }));
}

describe('refusing to combine', () => {
  it.each([
    ['a pack with two sources', `${source('a')}  - id: b\n`, 'pack one must hold only a list of sources with exactly one source'],
    ['a pack with a key beside the sources', `${source('a')}extra: 1\n`, 'pack one must hold only a list of sources with exactly one source'],
    ['a pack with no source', 'sources: []\n', 'pack one must hold only a list of sources with exactly one source'],
    ['a source without an ID', 'sources:\n  - uri: "bolt://x:7687"\n', 'the source of pack one has no ID'],
    ['text that is not YAML data', 'sources: *MARKER_SECRET_VALUE\n', 'pack one is not a YAML mapping'],
  ])('names the pack and writes nothing for %s', async (_name, text, message) => {
    const folder = scratch();
    pack(folder, 'one', text);
    pack(folder, 'two', source('b'));
    const out = join(folder, 'combined.yaml');
    const result = await run(['combine', '--packs', 'one,two', '--out', out], folder);
    expect(result.code).toBe(1);
    expect(result.err.join('\n')).toContain(message);
    expect(result.err.join('\n')).not.toContain('MARKER_SECRET_VALUE');
    expect(existsSync(out)).toBe(false);
  });

  it('refuses two packs with the same source ID, naming the second, and writes nothing', async () => {
    const folder = scratch();
    pack(folder, 'one', source('same'));
    pack(folder, 'two', source('same'));
    const out = join(folder, 'combined.yaml');
    const result = await run(['combine', '--packs', 'one,two', '--out', out], folder);
    expect(result.code).toBe(1);
    expect(result.err.join('\n')).toContain('pack two repeats a source ID of another pack');
    expect(existsSync(out)).toBe(false);
  });

  it('leaves an earlier file as it was when a later run is refused', () => {
    const folder = scratch();
    pack(folder, 'one', source('a'));
    const out = join(folder, 'combined.yaml');
    combinePacks(['one'], out, folder);
    const before = readFileSync(out, 'utf8');
    pack(folder, 'one', 'sources: []\n');
    expect(() => combinePacks(['one'], out, folder)).toThrow(CombineError);
    expect(readFileSync(out, 'utf8')).toBe(before);
  });

  it('leaves no temporary file behind and the destination as it was when the file cannot be put in place', () => {
    const folder = scratch();
    pack(folder, 'one', source('a'));
    const out = join(folder, 'config', 'neburyx.yaml');
    mkdirSync(out, { recursive: true });
    expect(() => combinePacks(['one'], out, folder)).toThrow();
    expect(readdirSync(join(folder, 'config'))).toEqual(['neburyx.yaml']);
  });

  it.each([[['combine', '--packs', 'a,,b', '--out', 'x']], [['combine', '--packs', 'a,a', '--out', 'x']], [['combine', '--packs', 'a']], [['combine', '--out', 'x']], [['combine', '--packs', 'a', '--out', 'x', '--seed', '3']]])('prints the usage and exits 2 for %j', async (argv) => {
    const result = await run(argv);
    expect(result.code).toBe(2);
    expect(result.err.join('\n')).toContain('demo-graph combine');
  });

  it('exits 2 for a pack that does not exist', async () => {
    const result = await run(['combine', '--packs', 'no-such-pack', '--out', join(scratch(), 'combined.yaml')]);
    expect(result.code).toBe(2);
  });
});

describe('combining the shipped packs', () => {
  it('writes exactly their source entries, read from the packs, and can run again over the file', async () => {
    expect(listPacks()).toEqual(expect.arrayContaining(SHIPPED));
    const out = join(scratch(), 'config', 'neburyx.yaml');
    for (let run_ = 0; run_ < 2; run_++) {
      const result = await run(['combine', '--packs', SHIPPED.join(','), '--out', out]);
      expect(result.code, result.err.join()).toBe(0);
    }
    const combined: unknown = parse(readFileSync(out, 'utf8'));
    const expected: unknown = { sources: SHIPPED.flatMap((name) => parse(readFileSync(packFiles(name).mapping, 'utf8')).sources) };
    expect(combined).toEqual(expected);
    expect(JSON.stringify(combined)).toContain('"synthetic":true');
  });
});
