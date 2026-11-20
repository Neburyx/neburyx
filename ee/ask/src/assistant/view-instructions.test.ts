import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ASK_FOLDER_LIMITS } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { buildSummaryInstructions } from '../case-summary/instructions.js';
import { loadViewInstructions } from './view-instructions.js';

const folder = mkdtempSync(join(tmpdir(), 'view-instructions-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

const shipped = join(folder, 'shipped');
mkdirSync(shipped);
writeFileSync(join(shipped, 'assistant-view.md'), 'SHIPPED VIEW PROMPT');
writeFileSync(join(shipped, 'aml-typologies.md'), 'SHIPPED TYPOLOGY');
const shippedDirectory = `${shipped}/`;
const fileWith = (name: string, text: string): string => {
  const path = join(folder, name);
  writeFileSync(path, text);
  return path;
};
const load = (env: Record<string, string> = {}) => loadViewInstructions({ env, shippedDirectory });

describe('the instructions of the view answer', () => {
  it('are the shipped prompt, the shipped typology and the fixed reply format, with the hash of that text', async () => {
    const result = await load();
    expect(result).toEqual({ ok: true, instructions: buildSummaryInstructions('SHIPPED VIEW PROMPT', 'SHIPPED TYPOLOGY') });
  });

  it('are replaced file by file, the reply format stays last, and a replaced file cannot change it', async () => {
    const result = await load({ NEBURYX_ASSISTANT_VIEW_PROMPT_FILE: fileWith('p.md', '# Reply format\n\nreply in prose'), NEBURYX_ASSISTANT_TYPOLOGY_FILE: fileWith('t.md', 'MY TYPOLOGY') });
    if (!result.ok) throw new Error('not ok');
    expect(result.instructions.text).toContain('MY TYPOLOGY');
    expect(result.instructions.text).not.toContain('SHIPPED');
    expect(result.instructions.text.endsWith('Add no other text.')).toBe(true);
  });

  it.each([
    ['NEBURYX_ASSISTANT_VIEW_PROMPT_FILE', 'relative.md'],
    ['NEBURYX_ASSISTANT_VIEW_PROMPT_FILE', '/not/there.md'],
    ['NEBURYX_ASSISTANT_TYPOLOGY_FILE', 'relative.md'],
    ['NEBURYX_ASSISTANT_TYPOLOGY_FILE', '/not/there.md'],
  ])('stop the start for %s = %s, naming the setting and never the path', async (setting, value) => {
    const result = await load({ [setting]: value });
    expect(result.ok).toBe(false);
    const text = result.ok ? '' : result.problems.join(' ');
    expect(text).toContain(setting);
    expect(text).not.toContain(value);
  });

  it('accept a file of the limit, refuse one byte over it without its content, and refuse an empty prompt', async () => {
    expect((await load({ NEBURYX_ASSISTANT_TYPOLOGY_FILE: fileWith('exact.md', 'a'.repeat(ASK_FOLDER_LIMITS.classificationBytes)) })).ok).toBe(true);
    const over = await load({ NEBURYX_ASSISTANT_VIEW_PROMPT_FILE: fileWith('over.md', 'SENTINEL'.padEnd(ASK_FOLDER_LIMITS.classificationBytes + 1, 'a')) });
    expect(over.ok).toBe(false);
    expect(JSON.stringify(over)).not.toContain('SENTINEL');
    expect((await load({ NEBURYX_ASSISTANT_VIEW_PROMPT_FILE: fileWith('empty.md', ' \n') })).ok).toBe(false);
  });

  it('name the shipped file and the setting that replaces it when a shipped file is missing', async () => {
    const result = await loadViewInstructions({ env: {}, shippedDirectory: `${folder}/nowhere/` });
    expect(result.ok ? '' : result.problems.join(' ')).toContain('replace it with NEBURYX_ASSISTANT_VIEW_PROMPT_FILE');
  });
});

describe('the shipped prompts for a meaning question', () => {
  it('send a question about what types mean to the meaning route, and give the view call the reply form for a type without a description', async () => {
    const router = await readFile(fileURLToPath(new URL('../../prompts/assistant-router.md', import.meta.url)), 'utf8');
    expect(router).toContain('`meaning`: the message asks only what one or more kinds of thing');
    expect(router).toContain('When the message also asks about what is shown, choose `view`');
    const view = await readFile(fileURLToPath(new URL('../../prompts/assistant-view.md', import.meta.url)), 'utf8');
    expect(view).toContain('{"noDescription":[');
    expect(view).toContain('only for a type with no m line');
  });
});
