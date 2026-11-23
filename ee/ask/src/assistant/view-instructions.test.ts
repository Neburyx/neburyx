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
const shippedDirectory = `${shipped}/`;
const fileWith = (name: string, text: string): string => {
  const path = join(folder, name);
  writeFileSync(path, text);
  return path;
};
const load = (env: Record<string, string> = {}) => loadViewInstructions({ env, shippedDirectory });

describe('the instructions of the view answer', () => {
  it('are the shipped prompt and the fixed reply format with no typology section, with the hash of that text', async () => {
    const result = await load();
    expect(result).toMatchObject({ ok: true, instructions: buildSummaryInstructions('SHIPPED VIEW PROMPT', ''), typology: [] });
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

  it('keeps the items of the typology list apart, five for the banking pack\'s file and none of its heading or paragraph', async () => {
    const pack = fileURLToPath(new URL('../../../../domain-packs/banking-fraud/ask/typologies.md', import.meta.url));
    const named = await load({ NEBURYX_ASSISTANT_TYPOLOGY_FILE: pack });
    expect(named.ok && named.typology).toHaveLength(5);
    expect(named.ok && named.typology.every((line) => !line.startsWith('#') && !line.startsWith('- '))).toBe(true);
    const none = await load();
    expect(none.ok && none.typology).toEqual([]);
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

describe('the shipped prompt of the answer from the view and after tool steps', () => {
  it('says what a direction in a line means, that an amount is copied as written, that no sum is ever written, and when the largest may be named', async () => {
    const result = await loadViewInstructions({ env: {} });
    if (!result.ok) throw new Error(result.problems.join('; '));
    const { text } = result.instructions;
    expect(text).toContain('the first end is the one the link starts from');
    expect(text).toContain('Copy an amount exactly as the line writes it');
    expect(text).toContain('Never write a sum, an average or a total of amounts');
    expect(text).toContain('Name "the largest" or "the smallest" of several elements only when you cite every one of them');
    expect(text).toContain('never write a count of elements you do not see');
    expect(text).toContain('An element whose line shows no amount is named as such');
  });
});

describe('the shipped prompt on the table form', () => {
  it('names the table reply form, says it is for the turn that asks for it, what a column label and a cell are, that a row cites elements and never a summary sentence, and that no sum, rank or percentage is a cell', async () => {
    const result = await loadViewInstructions({ env: {} });
    if (!result.ok) throw new Error(result.problems.join('; '));
    const { text } = result.instructions;
    expect(text).toContain('{"table":{"columns":["<label>",...],"rows":[{"cells":["<text>",...],"cites":["<key>",...]},...]}}');
    expect(text).toContain('When the question text ends with the line "The analyst asked for the answer as a table."');
    expect(text).toContain('A table has 1 to 6 columns, each a short plain label');
    expect(text).toContain('each copied exactly from the element text');
    expect(text).toContain('never write a key in a cell');
    expect(text).toContain("a column named Element holds the element's name or title as its line shows it, never its key such as n1");
    expect(text).toContain('no sum, rank or percentage is ever a cell');
    expect(text).toContain('never a sentence of a summary');
    expect(text).not.toContain('is answered with sentences as before');
  });
});
