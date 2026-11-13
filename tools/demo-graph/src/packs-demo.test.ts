import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { checkNamedNodes, namedNodes, readCases } from './cases.js';
import { readDefinition } from './definition.js';
import { writeExport } from './export.js';
import { generate } from './generate.js';
import { loadExport } from './load.js';
import { readMappingSource } from './mapping.js';
import { listPacks, packFiles } from './packs.js';
import { ExportError, readExport } from './validate.js';
import { dataFile, scratch } from './testing/export-helpers.js';
import { recordingDriver } from './testing/recording-driver.js';

const SHIPPED = ['banking-fraud', 'insurance-claims'] as const;
const packs = listPacks();

function dataBytes(directory: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const sub of ['nodes', 'relationships']) for (const name of readdirSync(join(directory, sub)).sort()) files.set(`${sub}/${name}`, readFileSync(join(directory, sub, name), 'utf8'));
  return files;
}

describe('the shipped packs', () => {
  it.each(SHIPPED)('%s is found on disk and has a demo definition', (name) => {
    expect(packs).toContain(name);
    expect(existsSync(packFiles(name).definition)).toBe(true);
  });
});

describe.each(packs.filter((name) => existsSync(packFiles(name).definition)))('the %s demo definition', (name) => {
  const files = packFiles(name);
  const mapping = readMappingSource(files.mapping);
  const definition = readDefinition(files.definition, mapping);

  it('is valid against its mapping, and every mapped type is generated', () => {
    expect(definition.entities.map((entity) => entity.type).sort()).toEqual(mapping.entities.map((entity) => entity.type).sort());
    expect(new Set(definition.blocks.map((block) => block.type))).toEqual(new Set(mapping.relationships.map((relationship) => relationship.type)));
  });

  it('gives byte-identical data files and manifest for the same seed at full size, and different ones for another seed', () => {
    const write = (seed: number) => {
      const directory = join(scratch(), 'export');
      writeExport(directory, generate(mapping, definition, seed));
      return directory;
    };
    const first = write(definition.seed);
    const second = write(definition.seed);
    const other = write(definition.seed + 1);
    expect(dataBytes(first)).toEqual(dataBytes(second));
    expect(readFileSync(join(first, 'manifest.json'), 'utf8')).toBe(readFileSync(join(second, 'manifest.json'), 'utf8'));
    const changed = [...dataBytes(first)].some(([file, text]) => dataBytes(other).get(file) !== text);
    expect(changed).toBe(true);
  });

  it('is refused by the loader before it connects when one byte of a data file is altered', async () => {
    const directory = join(scratch(), 'export');
    writeExport(directory, generate(mapping, definition, definition.seed));
    const file = join(directory, dataFile(directory, mapping.entities[0]?.type ?? ''));
    const text = readFileSync(file, 'utf8');
    writeFileSync(file, `${text.slice(0, 20)}${text[20] === 'A' ? 'B' : 'A'}${text.slice(21)}`);
    const { factory, recording } = recordingDriver();
    const env = { [mapping.usernameEnv]: 'reader', [mapping.passwordEnv]: 'a password value' };
    await expect(loadExport({ directory, source: mapping, env, reset: false, createDriver: factory })).rejects.toThrow(ExportError);
    expect(recording.drivers).toBe(0);
  });

  it.runIf(existsSync(files.cases))('has cases whose named nodes all exist in the export, and refuses a case that names a node that is not there', () => {
    const cases = readCases(files.cases, mapping, definition);
    const directory = join(scratch(), 'export');
    writeExport(directory, generate(mapping, definition, definition.seed));
    const data = readExport(directory);
    expect(() => checkNamedNodes(cases, mapping, data)).not.toThrow();
    const first = cases.cases[0]?.expect[0];
    if (first === undefined) throw new Error('the pack has no case');
    const missing = { preset: cases.preset, cases: [{ id: 'missing-node', title: 'A node that is not there', expect: [{ ...first, node: { type: first.node.type, id: 'NOT-IN-THE-EXPORT' } }] }] };
    let message = '';
    try {
      checkNamedNodes(missing, mapping, data);
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toContain('case missing-node, expectation 1: names a node that is not in the export');
    expect(message).not.toContain('NOT-IN-THE-EXPORT');
    expect(namedNodes(cases).filter(({ node }) => node.type === cases.preset.entity.type && node.id === cases.preset.entity.id).length).toBeGreaterThan(1);
    expect(() => checkNamedNodes({ ...cases, preset: { ...cases.preset, entity: { type: cases.preset.entity.type, id: 'NOT-IN-THE-EXPORT' } } }, mapping, data)).toThrow(/preset: names a node that is not in the export/);
  });
});

describe('the scripted demo cases of the shipped packs', () => {
  const counts = SHIPPED.map((name) => {
    const files = packFiles(name);
    const mapping = readMappingSource(files.mapping);
    return { name, cases: readCases(files.cases, mapping, readDefinition(files.definition, mapping)).cases };
  });

  it('are twelve in all, at least one in each pack and six in the insurance pack', () => {
    expect(counts.reduce((total, pack) => total + pack.cases.length, 0)).toBe(12);
    for (const pack of counts) expect(pack.cases.length, pack.name).toBeGreaterThanOrEqual(1);
    expect(counts.find((pack) => pack.name === 'insurance-claims')?.cases).toHaveLength(6);
  });
});

describe('the banking demo transfers', () => {
  const files = packFiles('banking-fraud');
  const mapping = readMappingSource(files.mapping);
  const definition = readDefinition(files.definition, mapping);
  const full = generate(mapping, definition, definition.seed);
  const transfersOf = (generated: typeof full) => generated.files.find((file) => file.type === 'TRANSFERRED_TO')?.lines ?? [];
  const members = new Map<string, number>();
  for (const line of transfersOf(full)) {
    const { f, t } = JSON.parse(line) as { f: string; t: string };
    members.set(`${f}>${t}`, (members.get(`${f}>${t}`) ?? 0) + 1);
  }

  it('hold one pair of accounts with several transfers, sent by the account the preset investigation starts at, and every other pair at one', () => {
    const preset = readCases(files.cases, mapping, definition).preset.entity;
    const several = [...members].filter(([, count]) => count > 1);
    expect(several).toHaveLength(1);
    expect(several[0]?.[1]).toBeGreaterThanOrEqual(5);
    expect(several[0]?.[1]).toBeLessThanOrEqual(12);
    expect(several[0]?.[0].startsWith(`${preset.id}>`)).toBe(true);
  });

  it('leave every other generated line as it was before the extra transfers were added', () => {
    const added = definition.blocks.filter((block) => block.type === 'TRANSFERRED_TO' && block.fromRange?.count === 1);
    expect(added.length).toBeGreaterThanOrEqual(5);
    const before = generate(mapping, { ...definition, blocks: definition.blocks.filter((block) => !added.includes(block)) }, definition.seed);
    for (const file of full.files) {
      const earlier = before.files.find((candidate) => candidate.type === file.type);
      if (file.type === 'TRANSFERRED_TO') expect(file.lines.slice(0, earlier?.lines.length)).toEqual(earlier?.lines);
      else expect(file.lines).toEqual(earlier?.lines);
    }
    expect(transfersOf(full)).toHaveLength(transfersOf(before).length + added.length);
  });
});
