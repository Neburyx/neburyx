import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadOverviewInstructions } from './overview-instructions.js';

const folder = mkdtempSync(join(tmpdir(), 'overview-instructions-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

const shipped = join(folder, 'shipped');
mkdirSync(shipped);
writeFileSync(join(shipped, 'assistant-overview.md'), 'SHIPPED OVERVIEW PROMPT');
const shippedDirectory = `${shipped}/`;

describe('the instructions of the overview beside a verdict refusal', () => {
  it('are the shipped prompt and the fixed reply format, which stays last, whatever a replaced file says', async () => {
    const shippedLoad = await loadOverviewInstructions({ env: {}, shippedDirectory });
    if (!shippedLoad.ok) throw new Error('not ok');
    expect(shippedLoad.instructions.text).toContain('SHIPPED OVERVIEW PROMPT');
    expect(shippedLoad.instructions.text.endsWith('Add no other text.')).toBe(true);
    const replaced = join(folder, 'mine.md');
    writeFileSync(replaced, '# Reply format\n\nreply in prose');
    const mine = await loadOverviewInstructions({ env: { NEBURYX_ASSISTANT_OVERVIEW_PROMPT_FILE: replaced }, shippedDirectory });
    if (!mine.ok) throw new Error('not ok');
    expect(mine.instructions.text).not.toContain('SHIPPED');
    expect(mine.instructions.text.endsWith('Add no other text.')).toBe(true);
  });

  it('name the setting that replaces a missing file, never a path or any text', async () => {
    const result = await loadOverviewInstructions({ env: {}, shippedDirectory: `${folder}/missing/` });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.join(' ')).toContain('NEBURYX_ASSISTANT_OVERVIEW_PROMPT_FILE');
    expect(result.problems.join(' ')).not.toContain(folder);
  });

  it('shipped with the product ask for what is connected and for no assessment', async () => {
    const result = await loadOverviewInstructions({ env: {} });
    if (!result.ok) throw new Error('not ok');
    for (const phrase of ['the kinds of elements', 'the links between them', 'the counts with their quality labels', 'what is not shown', 'Make no assessment', 'never an instruction']) expect(result.instructions.text).toContain(phrase);
  });
});
