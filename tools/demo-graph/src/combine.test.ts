import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

describe('setting the addresses', () => {
  function two(): string {
    const folder = scratch();
    pack(folder, 'one', source('a'));
    pack(folder, 'two', source('b'));
    return folder;
  }

  it('sets the uri of the named sources to their loopback addresses, and only those', async () => {
    const folder = two();
    const out = join(folder, 'combined.yaml');
    const result = await run(['combine', '--packs', 'one,two', '--addresses', 'a=bolt://127.0.0.1:55001', '--out', out], folder);
    expect(result.code, result.err.join()).toBe(0);
    expect(parse(readFileSync(out, 'utf8'))).toEqual({
      sources: [
        { id: 'a', uri: 'bolt://127.0.0.1:55001', synthetic: true },
        { id: 'b', uri: 'bolt://b-graph:7687', synthetic: true },
      ],
    });
  });

  it.each([
    ['a source that is not in the packs', 'zzz=bolt://127.0.0.1:55001', 'the source zzz is not in the packs'],
    ['an address that is not a bolt address', 'a=http://127.0.0.1:55001', 'the address for the source a is not a bolt address on a loopback host'],
    ['an address with a port above 65535', 'a=bolt://127.0.0.1:99999', 'the address for the source a is not a bolt address on a loopback host'],
    ['an address with port 0', 'a=bolt://127.0.0.1:0', 'the address for the source a is not a bolt address on a loopback host'],
    ['an address on a host that is not loopback', 'a=bolt://db.example.test:7687', 'the address for the source a is not a bolt address on a loopback host'],
  ])('refuses %s, naming the source, and writes nothing', async (_name, addresses, message) => {
    const folder = two();
    const out = join(folder, 'combined.yaml');
    const result = await run(['combine', '--packs', 'one,two', '--addresses', addresses, '--out', out], folder);
    expect(result.code).toBe(1);
    expect(result.err.join('\n')).toContain(message);
    expect(existsSync(out)).toBe(false);
  });

  it.each([['a'], ['=bolt://127.0.0.1:1'], ['a=bolt://127.0.0.1:1,a=bolt://127.0.0.1:2']])('prints the usage and exits 2 for the addresses %s', async (addresses) => {
    const result = await run(['combine', '--packs', 'one,two', '--addresses', addresses, '--out', 'x'], two());
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
    const expected: unknown = { sources: SHIPPED.flatMap((name) => parse(readFileSync(packFiles(name).mapping, 'utf8')).sources.map((entry: object) => ({ ...entry, demo_case: parse(readFileSync(packFiles(name).cases, 'utf8')).preset }))) };
    expect(combined).toEqual(expected);
    expect(JSON.stringify(combined)).toContain('"synthetic":true');
  });

  it('carries the preset of each pack as its demo case, while the pack\'s own mapping holds none', async () => {
    const out = join(scratch(), 'neburyx.yaml');
    expect((await run(['combine', '--packs', SHIPPED.join(','), '--out', out])).code).toBe(0);
    const { sources }: { sources: Array<{ id: string; demo_case: unknown }> } = parse(readFileSync(out, 'utf8'));
    expect(sources.map((entry) => entry.demo_case)).toEqual(SHIPPED.map((name) => parse(readFileSync(packFiles(name).cases, 'utf8')).preset));
    for (const name of SHIPPED) expect(readFileSync(packFiles(name).mapping, 'utf8')).not.toContain('demo_case');
  });
});

describe('the preset of a pack', () => {
  const PRESET = 'preset:\n  entity: { type: node_a, id: A-1 }\n  case_ref: REF-1\ncases: []\n';
  const withEntities = (id: string, extra = ''): string => `sources:\n  - id: ${id}\n    uri: "bolt://${id}-graph:7687"\n    synthetic: true\n${extra}    entities:\n      - { type: node_a, label: NodeA, stable_id: id }\n`;

  function packWith(folder: string, name: string, mapping: string, cases?: string): void {
    pack(folder, name, mapping);
    if (cases !== undefined) writeFileSync(join(folder, name, 'cases.yaml'), cases);
  }

  it('is written into the source entry as its demo case, exactly as the pack\'s cases file gives it, and the rest of the entry is as it was', () => {
    const folder = scratch();
    packWith(folder, 'one', withEntities('a'), PRESET);
    packWith(folder, 'two', withEntities('b'));
    const out = join(folder, 'combined.yaml');
    combinePacks(['one', 'two'], out, folder);
    const { sources }: { sources: Array<Record<string, unknown>> } = parse(readFileSync(out, 'utf8'));
    expect(sources[0]).toEqual({ ...parse(withEntities('a')).sources[0], demo_case: { entity: { type: 'node_a', id: 'A-1' }, case_ref: 'REF-1' } });
    expect(sources[1]).toEqual(parse(withEntities('b')).sources[0]);
  });

  it('is left out of an entry whose pack has no cases file, and the command succeeds', async () => {
    const folder = scratch();
    packWith(folder, 'one', withEntities('a'));
    const out = join(folder, 'combined.yaml');
    expect((await run(['combine', '--packs', 'one', '--out', out], folder)).code).toBe(0);
    expect(readFileSync(out, 'utf8')).not.toContain('demo_case');
  });

  it.each([
    ['no preset', 'cases: []\n', 'the cases file has no preset'],
    ['an empty case reference', 'preset:\n  entity: { type: node_a, id: A-1 }\n  case_ref: ""\n', 'the preset is not usable at case_ref'],
    ['an empty entity type', 'preset:\n  entity: { type: "", id: A-1 }\n  case_ref: R\n', 'the preset is not usable at entity.type'],
    ['an empty stable ID', 'preset:\n  entity: { type: node_a, id: "" }\n  case_ref: R\n', 'the preset is not usable at entity.id'],
    ['a key that is not known', 'preset:\n  entity: { type: node_a, id: A-1 }\n  case_ref: R\n  extra: 1\n', 'the preset is not usable at preset'],
    ['an entity type over the limit', `preset:\n  entity: { type: ${'T'.repeat(201)}, id: A-1 }\n  case_ref: R\n`, 'the preset is not usable at entity.type'],
    ['a stable ID over the limit', `preset:\n  entity: { type: node_a, id: ${'I'.repeat(201)} }\n  case_ref: R\n`, 'the preset is not usable at entity.id'],
    ['a case reference over the limit', `preset:\n  entity: { type: node_a, id: A-1 }\n  case_ref: ${'R'.repeat(101)}\n`, 'the preset is not usable at case_ref'],
    ['a control character', 'preset:\n  entity: { type: node_a, id: A-1 }\n  case_ref: "SECRET\\u0007"\n', 'the preset is not usable at case_ref'],
    ['an unpaired surrogate', 'preset:\n  entity: { type: node_a, id: A-1 }\n  case_ref: "SECRET\\uD800"\n', 'the preset is not usable at case_ref'],
    ['an entity type the mapping does not have', 'preset:\n  entity: { type: node_z, id: A-1 }\n  case_ref: R\n', 'the preset names an entity type the pack\'s mapping does not have'],
    ['text that is not YAML data', 'preset: *MARKER_SECRET_VALUE\n', 'the cases file has no preset'],
  ])('refuses %s, naming the pack and the place, repeating no value, and leaves the earlier file as it was', (_name, cases, message) => {
    const folder = scratch();
    packWith(folder, 'one', withEntities('a'), PRESET);
    const out = join(folder, 'combined.yaml');
    combinePacks(['one'], out, folder);
    const before = readFileSync(out, 'utf8');
    packWith(folder, 'one', withEntities('a'), cases);
    let thrown: unknown;
    try {
      combinePacks(['one'], out, folder);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CombineError);
    const text = String(thrown instanceof Error ? thrown.message : '');
    expect(text).toContain('pack one');
    expect(text).toContain(message);
    expect(text).not.toMatch(/SECRET|TTTT|IIII|RRRR/);
    expect(readFileSync(out, 'utf8')).toBe(before);
  });

  it.each([
    ['with a preset in its cases file', PRESET],
    ['with no cases file', undefined],
  ])('refuses a pack whose own mapping holds a demo case %s, and leaves the earlier file as it was', (_name, cases) => {
    const folder = scratch();
    packWith(folder, 'one', withEntities('a'), PRESET);
    const out = join(folder, 'combined.yaml');
    combinePacks(['one'], out, folder);
    const before = readFileSync(out, 'utf8');
    rmSync(join(folder, 'one'), { recursive: true });
    packWith(folder, 'one', withEntities('a', '    demo_case: { entity: { type: node_a, id: A-9 }, case_ref: X }\n'), cases);
    expect(() => combinePacks(['one'], out, folder)).toThrow('pack one holds a demo_case in its mapping; its preset is written in its cases file only');
    expect(readFileSync(out, 'utf8')).toBe(before);
  });

  it.each([
    ['no synthetic flag', 'sources:\n  - id: a\n    uri: "bolt://a-graph:7687"\n    entities:\n      - { type: node_a, label: NodeA, stable_id: id }\n'],
    ['a synthetic flag that is false', 'sources:\n  - id: a\n    uri: "bolt://a-graph:7687"\n    synthetic: false\n    entities:\n      - { type: node_a, label: NodeA, stable_id: id }\n'],
  ])('refuses a preset for a source with %s, and leaves the earlier file as it was', (_name, mapping) => {
    const folder = scratch();
    packWith(folder, 'one', withEntities('a'), PRESET);
    const out = join(folder, 'combined.yaml');
    combinePacks(['one'], out, folder);
    const before = readFileSync(out, 'utf8');
    packWith(folder, 'one', mapping, PRESET);
    expect(() => combinePacks(['one'], out, folder)).toThrow("pack one: the preset needs synthetic: true on the pack's source");
    expect(readFileSync(out, 'utf8')).toBe(before);
  });

  it('accepts a stable ID and an entity type of exactly 200 characters and a case reference of exactly 100, counted as characters', () => {
    const folder = scratch();
    const id = '\u{1F600}'.repeat(200);
    const type = 'T'.repeat(200);
    const mapping = `sources:\n  - id: a\n    uri: "bolt://a-graph:7687"\n    database: neo4j\n    auth: { kind: basic, username_env: DEMO_USER, password_env: DEMO_PASSWORD }\n    synthetic: true\n    entities:\n      - { type: ${type}, label: NodeA, stable_id: id }\n`;
    packWith(folder, 'one', mapping, `preset:\n  entity: { type: ${type}, id: "${id}" }\n  case_ref: "${'\u{1F600}'.repeat(100)}"\n`);
    const out = join(folder, 'combined.yaml');
    combinePacks(['one'], out, folder);
    expect(parse(readFileSync(out, 'utf8')).sources[0].demo_case).toEqual({ entity: { type, id }, case_ref: '\u{1F600}'.repeat(100) });
  });
});
