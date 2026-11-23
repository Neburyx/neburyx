import { describe, expect, it } from 'vitest';
import { repoRoot } from '../workspace.js';
import { checkAiText, formatAiTextResult, scanAiText } from './ai-text.js';
import { makeRoot, packText } from './fixtures.js';

const PACK = packText([['widget', 'Widget']], ['MADE_BY']);
const SENTENCE = 'Say who made the thing and what it is connected to in the lines you were given';

function rootWith(files: Readonly<Record<string, string>>): string {
  return makeRoot({ 'domain-packs/sample/neburyx.yaml': PACK, ...files });
}

describe('a pack word in the instruction text', () => {
  it.each([
    ['a prompt file, with a different case', { 'ee/ask/prompts/p.md': 'Line one\nWhat is a Widget here?\n' }, 'ee/ask/prompts/p.md', 2, 'widget'],
    ['a relationship type in a prompt file', { 'ee/ask/prompts/p.md': 'Explain what MADE_BY stands for.\n' }, 'ee/ask/prompts/p.md', 1, 'made by'],
    ['a sentence in the code that builds the agent text', { 'ee/ask/src/a.ts': `export const text = '${SENTENCE} and any widget';\n` }, 'ee/ask/src/a.ts', 1, 'widget'],
    ['a template of the assistant agent', { 'ee/assistant-agent/src/a.ts': `export const text = \`${SENTENCE} of a widget\`;\n` }, 'ee/assistant-agent/src/a.ts', 1, 'widget'],
  ])('is reported in %s with its file, line and word', (_name, files, file, line, word) => {
    const result = checkAiText(rootWith(files), []);
    expect(result.violations).toEqual([{ file, line, word, uses: expect.arrayContaining([expect.stringContaining('in sample')]) }]);
    expect(formatAiTextResult(result)).toContain(`${file}:${line} '${word}'`);
  });

  it('is not reported in a name with no space in it, in a longer word, or in a test file', () => {
    const files = {
      'ee/ask/src/a.ts': "export const kind = 'widget';\nexport const word = 'This sentence only has widgetry and gadgets in other words, nothing more';\n",
      'ee/ask/src/a.test.ts': `export const text = '${SENTENCE} and a widget';\n`,
      'ee/ask/src/testing/rig.ts': `export const text = '${SENTENCE} and a widget';\n`,
    };
    expect(checkAiText(rootWith(files), []).violations).toEqual([]);
  });

  it.each([
    ['a plural', 'List the widgets in view.'],
    ['a plural in -ies of a name in -y', 'Say what the policies cover.'],
    ['a short literal', 'a widget here'],
    ['the words of a snake_case name apart', 'Who was it made by?'],
    ['the words of a camelCase name apart', 'Read the ip address.'],
  ])('is reported for %s', (_name, text) => {
    const pack = packText([['widget', 'Widget'], ['policy', 'Policy'], ['ipAddress', 'IpAddress']], ['MADE_BY']).replace('stable_id: id }', 'stable_id: id }');
    const root = makeRoot({ 'domain-packs/sample/neburyx.yaml': pack, 'ee/ask/src/a.ts': `export const text = ${JSON.stringify(text)};\n` });
    expect(checkAiText(root, []).violations.length).toBeGreaterThan(0);
  });

  it('is reported in a piece of a template literal that has a substitution', () => {
    const root = rootWith({ 'ee/ask/src/a.ts': 'export const text = (n: number) => `${n} widgets in view`;\n' });
    expect(checkAiText(root, []).violations.map((v) => v.word)).toEqual(['widget']);
  });

  it('is reported in a multi-word label of a pack', () => {
    const root = makeRoot({ 'domain-packs/sample/neburyx.yaml': packText([['gizmo', 'Frozen-thing']]), 'ee/ask/prompts/p.md': 'Is the frozen thing here?\n' });
    expect(checkAiText(root, []).violations.length).toBeGreaterThan(0);
  });

  it('reads the prompt files of a folder inside the prompts folder too', () => {
    expect(checkAiText(rootWith({ 'ee/ask/prompts/more/p.md': 'A widget.\n' }), []).violations.map((v) => v.file)).toEqual(['ee/ask/prompts/more/p.md']);
  });

  it('is allowed with a reason for a word everywhere, or for one file only, and an entry nothing uses is reported', () => {
    const files = { 'ee/ask/prompts/p.md': 'A widget.\n', 'ee/ask/prompts/q.md': 'Another widget.\n' };
    const root = rootWith(files);
    expect(checkAiText(root, [{ word: 'widget', reason: 'ordinary here' }])).toEqual({ violations: [], unused: [] });
    const one = checkAiText(root, [{ word: 'widget', file: 'ee/ask/prompts/p.md', reason: 'this file only' }]);
    expect(one.violations.map((v) => v.file)).toEqual(['ee/ask/prompts/q.md']);
    const stale = checkAiText(root, [{ word: 'widget', reason: 'ordinary here' }, { word: 'gadget', reason: 'nothing uses it' }]);
    expect(stale.unused.map((entry) => entry.word)).toEqual(['gadget']);
    expect(formatAiTextResult(stale)).toContain("allowlist entry 'gadget'");
  });

  it('reads the words from every pack, so a second pack is covered with no change of code', () => {
    const root = makeRoot({
      'domain-packs/one/neburyx.yaml': PACK,
      'domain-packs/two/neburyx.yaml': packText([['policyholder', 'Policyholder']]),
      'ee/ask/prompts/p.md': 'Is a policyholder here?\n',
    });
    expect(scanAiText(root).map((v) => v.word)).toEqual(['policyholder']);
  });
});

describe('the repository', () => {
  it('holds no word of a pack in its instruction text but the ordinary words and the open items the allowlist names, each with its reason', () => {
    const result = checkAiText(repoRoot);
    expect(formatAiTextResult(result)).toBe('');
  });
});
