import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ASK_FOLDER_LIMITS } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { loadSummaryInstructions } from './load-instructions.js';

const root = mkdtempSync(join(tmpdir(), 'case-summary-load-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const SENTINEL_TEXT = 'SENTINEL-FILE-TEXT';

function shippedFolder(name: string, files: Record<string, Buffer | string | null>): string {
  const directory = join(root, name);
  mkdirSync(directory);
  for (const [file, content] of Object.entries(files)) if (content !== null) writeFileSync(join(directory, file), content);
  return `${directory}/`;
}

const GOOD = { 'summary-prompt.md': 'prompt text', 'aml-typologies.md': 'typology text' };

describe('loading the shipped summary files', () => {
  it('builds the instructions from the files shipped in the product', async () => {
    const loaded = await loadSummaryInstructions();
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.instructions.text).toContain('Never state or imply guilt');
      expect(loaded.instructions.text).toContain('Fan-in');
      expect(loaded.instructions.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it.each([
    ['a missing prompt', { ...GOOD, 'summary-prompt.md': null }, 'summary-prompt.md', 'NEBURYX_SUMMARY_PROMPT_FILE'],
    ['a missing typology file', { ...GOOD, 'aml-typologies.md': null }, 'aml-typologies.md', 'NEBURYX_SUMMARY_TYPOLOGY_FILE'],
    ['an oversized prompt', { ...GOOD, 'summary-prompt.md': `${SENTINEL_TEXT}${'x'.repeat(ASK_FOLDER_LIMITS.classificationBytes)}` }, 'summary-prompt.md', 'NEBURYX_SUMMARY_PROMPT_FILE'],
    ['a prompt that is not UTF-8', { ...GOOD, 'summary-prompt.md': Buffer.from([0xff, 0xfe, 0xfd]) }, 'summary-prompt.md', 'NEBURYX_SUMMARY_PROMPT_FILE'],
    ['an oversized typology file', { ...GOOD, 'aml-typologies.md': 'x'.repeat(ASK_FOLDER_LIMITS.classificationBytes + 1) }, 'aml-typologies.md', 'NEBURYX_SUMMARY_TYPOLOGY_FILE'],
  ])('refuses %s naming the file and the replacing setting, with no path or text', async (name, files, file, setting) => {
    const shippedDirectory = shippedFolder(`case-${name.replaceAll(' ', '-')}`, files);
    const loaded = await loadSummaryInstructions({ shippedDirectory });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    const message = loaded.problems.join('\n');
    expect(message).toContain(file);
    expect(message).toContain(setting);
    expect(message).not.toContain(root);
    expect(message).not.toContain(SENTINEL_TEXT);
  });

  it('refuses an unreadable file without printing its path', async () => {
    const shippedDirectory = shippedFolder('unreadable', GOOD);
    chmodSync(join(shippedDirectory, 'summary-prompt.md'), 0o000);
    const loaded = await loadSummaryInstructions({ shippedDirectory });
    chmodSync(join(shippedDirectory, 'summary-prompt.md'), 0o600);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.problems.join('\n')).not.toContain(root);
  });
});
