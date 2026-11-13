import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';
import { PACKS, repoRoot } from '../../../services/api/src/testing/pack-fixtures.js';
import { PACKS_FOLDER } from './packs.js';

/** The test file that proves each preset of each shipped pack on its demo graph. A preset with no entry, or an entry that names a file that is not there, fails the check below. */
export const PROOFS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'banking-fraud': {
    'shared-devices': 'shared-attribute.neo4j.test.ts',
    'shared-addresses': 'shared-attribute.neo4j.test.ts',
    'connected-accounts': 'connected-accounts.neo4j.test.ts',
  },
  'insurance-claims': {
    'shared-addresses': 'insurance-presets.neo4j.test.ts',
    'claimant-claims': 'insurance-presets.neo4j.test.ts',
  },
};

const ALLOWED = new Set(['.yaml', '.md']);

/** Every file under the folder whose extension is not one a pack may hold. */
export function codeFilesIn(folder: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) found.push(...codeFilesIn(path));
    else if (!ALLOWED.has(extname(entry.name))) found.push(path);
  }
  return found;
}

/** The presets of the packs that have no proof entry, or whose proof file is missing. */
export function unproved(presets: Readonly<Record<string, readonly string[]>>, proofs: Readonly<Record<string, Readonly<Record<string, string>>>>, read: (file: string) => string | undefined): string[] {
  const problems: string[] = [];
  for (const [pack, ids] of Object.entries(presets)) {
    for (const id of ids) {
      const file = proofs[pack]?.[id];
      if (file === undefined) problems.push(`${pack}: the preset ${id} has no proof`);
      else {
        const text = read(file);
        if (text === undefined) problems.push(`${pack}: the proof of ${id} names a file that is not there`);
        else if (!text.includes(`'${id}'`)) problems.push(`${pack}: the file that proves ${id} never runs it`);
      }
    }
  }
  return problems;
}

const fileSchema = z.object({ sources: z.array(z.object({ patterns: z.array(z.object({ id: z.string(), template: z.string() })).optional() })) });
const presetsOf = (pack: string) => (fileSchema.parse(parse(readFileSync(join(repoRoot, 'domain-packs', pack, 'neburyx.yaml'), 'utf8'))).sources[0]?.patterns ?? []);
const declared = Object.fromEntries(PACKS.map((pack) => [pack, presetsOf(pack).map((preset) => preset.id)]));
const here = join(repoRoot, 'tools', 'demo-graph', 'src');

describe('the presets of the shipped packs', () => {
  it('are held in files that are YAML or Markdown only, so a preset needs no code', () => {
    expect(codeFilesIn(PACKS_FOLDER)).toEqual([]);
  });

  it('names a file that is not YAML or Markdown, in a folder that holds one', () => {
    const folder = mkdtempSync(join(tmpdir(), 'pack-files-'));
    try {
      mkdirSync(join(folder, 'pack'));
      writeFileSync(join(folder, 'pack', 'neburyx.yaml'), 'sources: []\n');
      writeFileSync(join(folder, 'pack', 'preset.js'), 'export {};\n');
      expect(codeFilesIn(folder)).toEqual([join(folder, 'pack', 'preset.js')]);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('each use a built-in template and have a test that proves them on the demo graph', () => {
    for (const pack of PACKS) for (const preset of presetsOf(pack)) expect(['shared-attribute', 'linked-entities'], `${pack}: ${preset.id}`).toContain(preset.template);
    expect(unproved(declared, PROOFS, (file) => (existsSync(join(here, file)) ? readFileSync(join(here, file), 'utf8') : undefined))).toEqual([]);
  });

  it('reports a preset with no proof, a proof whose file is missing and a file that never runs the preset', () => {
    expect(unproved({ 'banking-fraud': ['shared-devices', 'extra'] }, { 'banking-fraud': { 'shared-devices': 'a.test.ts' } }, () => "run('shared-devices')")).toEqual(['banking-fraud: the preset extra has no proof']);
    expect(unproved({ 'banking-fraud': ['shared-devices'] }, { 'banking-fraud': { 'shared-devices': 'gone.test.ts' } }, () => undefined)).toEqual(['banking-fraud: the proof of shared-devices names a file that is not there']);
    expect(unproved({ 'banking-fraud': ['shared-devices'] }, { 'banking-fraud': { 'shared-devices': 'a.test.ts' } }, () => "run('another-preset')")).toEqual(['banking-fraud: the file that proves shared-devices never runs it']);
  });
});
