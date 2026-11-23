import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createEnterpriseExtension } from './index.js';
import { loadAskFolder } from './folder/load.js';
import { loadViewInstructions } from './assistant/view-instructions.js';
import { makeAskFolder, removeAskFolders } from './testing/ask-folder.js';

const PACKS = fileURLToPath(new URL('../../../domain-packs/', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'typology-sources-'));
afterAll(() => {
  removeAskFolders();
  rmSync(scratch, { recursive: true, force: true });
});

const TEXT = '# Shapes\n\nThese are structures, not findings.\n\n- Hub: many link to one.\n- Ring: links return to where they began.\n';
const withTypology = (sources: readonly string[], typologyOf: Readonly<Record<string, string>>): string => {
  const folder = makeAskFolder(sources);
  for (const [id, text] of Object.entries(typologyOf)) writeFileSync(join(folder, id, 'typologies.md'), text);
  return folder;
};
const env = (folder: string, more: Record<string, string> = {}) => ({ NEBURYX_ASK_API_KEY: 'k', NEBURYX_ASK_MAPPING_FOLDER: folder, ...more });

describe('the typology text of a source', () => {
  it('is read from the optional file of the source folder, with its hash, and absent for a source without it', async () => {
    const loaded = await loadAskFolder({ folder: withTypology(['a', 'b'], { a: TEXT }), sourceIds: ['a', 'b'] });
    expect(loaded.ok && loaded.folder.source('a')?.typology?.text).toBe(TEXT);
    expect(loaded.ok && loaded.folder.source('a')?.typology?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.ok && loaded.folder.source('b')?.typology).toBeUndefined();
  });

  it('refuses a typology file over the size of a classification file, naming it and not its text', async () => {
    const loaded = await loadAskFolder({ folder: withTypology(['a'], { a: `SENTINEL${'x'.repeat(70_000)}` }), sourceIds: ['a'] });
    expect(loaded.ok).toBe(false);
    const text = loaded.ok ? '' : loaded.problems.join(' ');
    expect(text).toContain('a/typologies.md');
    expect(text).not.toContain('SENTINEL');
  });

  it('gives the instructions of each source its own typology: one source with a typology, one with none, and the operator\'s file for both', async () => {
    const extension = createEnterpriseExtension();
    const folder = withTypology(['a', 'b'], { a: TEXT });
    expect(await extension.configure?.({}, env(folder), { sourceIds: ['a', 'b'] })).toEqual({ ok: true });
    const withIt = extension.summaryInstructions('a');
    const without = extension.summaryInstructions('b');
    expect(withIt?.text).toContain('- Hub: many link to one.');
    expect(without?.text).not.toContain('Hub');
    expect(without?.text).not.toContain('# Shapes');
    expect(withIt?.sha256).not.toBe(without?.sha256);

    const own = join(scratch, 'own.md');
    writeFileSync(own, '# Own\n\n- Own shape: one.\n');
    const replaced = createEnterpriseExtension();
    expect(await replaced.configure?.({}, env(folder, { NEBURYX_SUMMARY_TYPOLOGY_FILE: own }), { sourceIds: ['a', 'b'] })).toEqual({ ok: true });
    for (const id of ['a', 'b']) {
      expect(replaced.summaryInstructions(id)?.text).toContain('Own shape');
      expect(replaced.summaryInstructions(id)?.text).not.toContain('Hub');
    }
  });

  it('is the same text, so the same hash, whether it comes from the pack\'s folder or from the file the operator names', async () => {
    const pack = join(PACKS, 'banking-fraud', 'ask', 'typologies.md');
    const fromFolder = createEnterpriseExtension();
    const folder = makeAskFolder(['a']);
    writeFileSync(join(folder, 'a', 'typologies.md'), readFileSync(pack, 'utf8'));
    await fromFolder.configure?.({}, env(folder), { sourceIds: ['a'] });
    const fromFile = createEnterpriseExtension();
    await fromFile.configure?.({}, env(makeAskFolder(['a']), { NEBURYX_SUMMARY_TYPOLOGY_FILE: pack }), { sourceIds: ['a'] });
    expect(fromFolder.summaryInstructions('a')?.sha256).toBe(fromFile.summaryInstructions('a')?.sha256);
  });
});

describe('the typology of the shipped packs', () => {
  it('is in the banking pack\'s Ask folder and absent from the insurance pack\'s, which then has no section and no list', async () => {
    expect(existsSync(join(PACKS, 'banking-fraud', 'ask', 'typologies.md'))).toBe(true);
    expect(existsSync(join(PACKS, 'insurance-claims', 'ask', 'typologies.md'))).toBe(false);
    const loaded = await loadViewInstructions({ env: {} });
    expect(loaded.ok && loaded.typologyFor('')).toEqual([]);
    const text = readFileSync(join(PACKS, 'banking-fraud', 'ask', 'typologies.md'), 'utf8');
    expect(loaded.ok && loaded.typologyFor(text)).toHaveLength(5);
    expect(loaded.ok && loaded.instructionsFor(text).text).toContain('Fan-in');
    expect(loaded.ok && loaded.instructionsFor('').text).not.toContain('Fan-in');
  });
});
