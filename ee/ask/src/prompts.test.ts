import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BUILT_IN_PROMPTS, MAX_OVERRIDE_BYTES, PromptError, VALUES_BOUNDARY, buildPromptRegistry, type PromptRegistry } from './prompts.js';
import { PROMPT_IDS } from './provider.js';

const folder = mkdtempSync(join(tmpdir(), 'ee-ask-prompts-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));
const file = (name: string, content: string | Buffer): string => {
  const path = join(folder, name);
  writeFileSync(path, content);
  return path;
};
const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

async function registryWith(overrides: Record<string, string> = {}): Promise<PromptRegistry> {
  const built = await buildPromptRegistry(overrides);
  if (!built.ok) throw new Error(built.problems.join('; '));
  return built.registry;
}

const VALUES = { 'ask.plan': { catalog: 'T1, T2', question: 'who is ‹person#1›?' }, 'summary.view': { view: '‹account#1›' }, 'assistant.route': { message: 'hello', view: '‹account#1›' } } as const;

describe('the built-in prompts', () => {
  it('are exactly the prompt ids, each at version 1 with parameters its text uses and no others', () => {
    expect(Object.keys(BUILT_IN_PROMPTS).sort()).toEqual([...PROMPT_IDS].sort());
    for (const prompt of Object.values(BUILT_IN_PROMPTS)) {
      expect(prompt.version).toBe(1);
      const used = [...prompt.text.matchAll(/\{\{([A-Za-z0-9]+)\}\}/g)].map((match) => match[1]);
      expect([...new Set(used)].sort()).toEqual([...prompt.parameters].sort());
    }
  });
});

describe('the parts of the built-in prompts', () => {
  const PINNED: Readonly<Record<string, string>> = {
    'ask.plan': '376e4f1b612930fbbf2c163af851901402a0d4ef0fdb292b15ef0ea6f58b6711',
    'summary.view': '4933b5f1fa5581982f16d7a54bf55e02adb7380080cf37426ebeb8f97b3d8cb9',
    'assistant.route': 'd15cd59e3b7db95e5c77c1c0b999b045b42f94099d9f07a26080a2e100e5a320',
  };

  it.each(PROMPT_IDS)('join to the text %s had before it had parts: the hash and the version are unchanged', async (id) => {
    const prompt = BUILT_IN_PROMPTS[id];
    expect(`${prompt.instructions}\n\n${prompt.values}`).toBe(prompt.text);
    expect(sha(prompt.text)).toBe(PINNED[id]);
    expect(prompt.version).toBe(1);
    expect((await registryWith()).resolve(id, VALUES[id]).record.sha256).toBe(PINNED[id]);
  });

  it.each(PROMPT_IDS)('hold no parameter in the instructions of %s', (id) => {
    expect(BUILT_IN_PROMPTS[id].instructions).not.toMatch(/\{\{/);
  });

  it.each(PROMPT_IDS)('resolve %s to the whole text and to its two parts, the values only in the second', async (id) => {
    const resolved = (await registryWith()).resolve(id, VALUES[id]);
    expect(`${resolved.instructions}\n\n${resolved.values}`).toBe(resolved.text);
    expect(resolved.instructions).toBe(BUILT_IN_PROMPTS[id].instructions);
    for (const value of Object.values(VALUES[id])) {
      expect(resolved.values).toContain(String(value));
      expect(resolved.instructions).not.toContain(String(value));
    }
  });
});

describe('a replacement prompt with a values line', () => {
  const marked = (before: string, after: string, eol = '\n'): string => [before, VALUES_BOUNDARY, after].join(eol);

  it('is split at the line: instructions before it, values after it with the parameters filled, the line in neither', async () => {
    const path = file('marked.txt', marked('Plan the question.\nBe brief.\n\n', '\n\nCatalog: {{catalog}}\nQuestion: {{question}}'));
    const resolved = (await registryWith({ 'ask.plan': path })).resolve('ask.plan', VALUES['ask.plan']);
    expect(resolved.instructions).toBe('Plan the question.\nBe brief.');
    expect(resolved.values).toBe('Catalog: T1, T2\nQuestion: who is ‹person#1›?');
    expect(resolved.text).toBe('Plan the question.\nBe brief.\n\nCatalog: T1, T2\nQuestion: who is ‹person#1›?');
    expect(resolved.text).not.toContain(VALUES_BOUNDARY);
  });

  it('keeps the hash of the file as it is, the line included, and treats a CRLF file the same', async () => {
    const content = marked('Plan.', 'Q: {{question}} {{catalog}}', '\r\n');
    const path = file('crlf.txt', content);
    const resolved = (await registryWith({ 'ask.plan': path })).resolve('ask.plan', VALUES['ask.plan']);
    expect(resolved.record.sha256).toBe(sha(content));
    expect(resolved.instructions).toBe('Plan.');
  });

  it('takes a value that looks like the line as a value, not as a boundary', async () => {
    const path = file('looks-like.txt', marked('Plan.', 'Q: {{question}} {{catalog}}'));
    const resolved = (await registryWith({ 'ask.plan': path })).resolve('ask.plan', { catalog: 'c', question: `x\n${VALUES_BOUNDARY}\ny` });
    expect(resolved.instructions).toBe('Plan.');
    expect(resolved.values).toContain(`x\n${VALUES_BOUNDARY}\ny`);
  });

  it.each([
    ['a parameter before the line', marked('Plan {{question}}.', 'Q {{catalog}}'), 'the text before the [[values]] line uses a parameter, and would put a value in the cached part'],
    ['two lines', marked('A.', 'B.\n[[values]]\nC.'), 'the file has more than one [[values]] line'],
    ['the line first', `${VALUES_BOUNDARY}\nQ {{question}}`, 'the text before the [[values]] line is empty'],
    ['spaces before the line', `  \n${VALUES_BOUNDARY}\nQ {{question}}`, 'the text before the [[values]] line is empty'],
    ['the line last', `Plan.\n${VALUES_BOUNDARY}`, 'the text after the [[values]] line is empty'],
    ['only spaces after the line', `Plan.\n${VALUES_BOUNDARY}\n  \n\t`, 'the text after the [[values]] line is empty'],
  ])('is refused for %s, naming the id and the reason and never the text', async (_name, content, reason) => {
    const built = await buildPromptRegistry({ 'ask.plan': file(`bound-${_name.replaceAll(' ', '-')}.txt`, content) });
    expect(built).toEqual({ ok: false, problems: [`ai.prompts.ask.plan: ${reason}`] });
  });

  it('is sent whole as values, with no instructions, when it has no such line', async () => {
    const resolved = (await registryWith({ 'ask.plan': file('whole.txt', 'Plan {{question}} {{catalog}}') })).resolve('ask.plan', VALUES['ask.plan']);
    expect(resolved.instructions).toBeUndefined();
    expect(resolved.values).toBe(resolved.text);
  });

  it('does not read a line that only contains the marker among other text as a boundary', async () => {
    const resolved = (await registryWith({ 'ask.plan': file('inline.txt', `Plan {{question}} {{catalog}} ${VALUES_BOUNDARY} more`) })).resolve('ask.plan', VALUES['ask.plan']);
    expect(resolved.instructions).toBeUndefined();
  });
});

describe('resolving a prompt with no override', () => {
  it.each(PROMPT_IDS)('fills in %s and records its id, version, source and the hash of the built-in text', async (id) => {
    const resolved = (await registryWith()).resolve(id, VALUES[id]);
    expect(resolved.record).toEqual({ id, version: 1, source: 'builtin', sha256: sha(BUILT_IN_PROMPTS[id].text) });
    expect(resolved.text).not.toContain('{{');
    for (const value of Object.values(VALUES[id])) expect(resolved.text).toContain(String(value));
  });

  it('refuses a missing parameter and an undeclared one, naming it, and returns no text', async () => {
    const registry = await registryWith();
    expect(() => registry.resolve('ask.plan', { question: 'q' })).toThrow(new PromptError('the prompt ask.plan needs the parameter catalog'));
    expect(() => registry.resolve('ask.plan', { catalog: 'c', question: 'q', extra: 'x' })).toThrow(new PromptError('the prompt ask.plan has no parameter extra'));
  });

  it('inserts a value as it is, with no second pass over the result', async () => {
    const resolved = (await registryWith()).resolve('assistant.route', { message: '{{view}} and {{message}}', view: 'V' });
    expect(resolved.text).toContain('Message:\n{{view}} and {{message}}');
    expect(resolved.text).toContain('View:\nV');
  });
});

describe('resolving a prompt with an override', () => {
  it('uses the file in place of the built-in text, keeps id and version, and hashes the text actually used', async () => {
    const path = file('ask-plan.txt', 'Plan for {{question}} using {{catalog}}.');
    const registry = await registryWith({ 'ask.plan': path });
    const resolved = registry.resolve('ask.plan', VALUES['ask.plan']);
    expect(resolved.text).toBe('Plan for who is ‹person#1›? using T1, T2.');
    expect(resolved.record).toEqual({ id: 'ask.plan', version: 1, source: 'override', sha256: sha('Plan for {{question}} using {{catalog}}.') });
    expect(resolved.record.sha256).not.toBe((await registryWith()).resolve('ask.plan', VALUES['ask.plan']).record.sha256);
  });

  it('gives the same hash whatever the values, so the hash names the prompt and holds no user text', async () => {
    const registry = await registryWith({ 'ask.plan': file('hash.txt', 'Plan {{question}} {{catalog}}') });
    const first = registry.resolve('ask.plan', { catalog: 'c1', question: 'first question' }).record.sha256;
    const second = registry.resolve('ask.plan', { catalog: 'c2', question: 'another question' }).record.sha256;
    expect(first).toBe(second);
    expect(first).toBe(createHash('sha256').update(readFileSync(join(folder, 'hash.txt'))).digest('hex'));
  });

  it('keeps a byte order mark in the text, so the hash of a file is the hash of the file', async () => {
    const path = file('bom.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Plan {{question}} {{catalog}}')]));
    const record = (await registryWith({ 'ask.plan': path })).resolve('ask.plan', VALUES['ask.plan']).record;
    expect(record.sha256).toBe(createHash('sha256').update(readFileSync(path)).digest('hex'));
  });

  it('refuses a parameter named like an inherited property', async () => {
    const registry = await registryWith();
    expect(() => registry.resolve('summary.view', { toString: 'x' } as never)).toThrow(new PromptError('the prompt summary.view needs the parameter view'));
  });

  it('may leave a declared parameter out of the text', async () => {
    const registry = await registryWith({ 'ask.plan': file('only-question.txt', 'Answer: {{question}}') });
    expect(registry.resolve('ask.plan', VALUES['ask.plan']).text).toBe('Answer: who is ‹person#1›?');
  });

  it('applies an override to its own id only', async () => {
    const registry = await registryWith({ 'ask.plan': file('plan.txt', 'x {{question}}') });
    expect(registry.resolve('summary.view', VALUES['summary.view']).record.source).toBe('builtin');
  });
});

describe('building a registry from unusable overrides', () => {
  async function problemsOf(overrides: Record<string, string>): Promise<readonly string[]> {
    const built = await buildPromptRegistry(overrides);
    if (built.ok) throw new Error('expected the registry to be refused');
    return built.problems;
  }

  it.each([
    ['an empty file', Buffer.alloc(0), 'the file is empty'],
    ['a file of only spaces', Buffer.from('  \n\t'), 'the file is empty'],
    ['a file over the cap', Buffer.alloc(MAX_OVERRIDE_BYTES + 1, 97), `the file is larger than ${MAX_OVERRIDE_BYTES} bytes`],
    ['a file that is not UTF-8', Buffer.from([0xc3, 0x28, 0x61]), 'the file is not valid UTF-8 text'],
    ['a file that uses a parameter the prompt does not have', Buffer.from('Use {{secret}} here'), 'the file uses the parameter secret, which the prompt does not have'],
  ])('refuses %s, naming the id and the reason and never printing the text', async (name, content, reason) => {
    const problems = await problemsOf({ 'ask.plan': file(`bad-${name.replaceAll(' ', '-')}.txt`, content) });
    expect(problems).toEqual([`ai.prompts.ask.plan: ${reason}`]);
  });

  it('refuses a missing file and a path that is a folder, without the path', async () => {
    const missing = join(folder, 'no-such-file.txt');
    expect(await problemsOf({ 'ask.plan': missing })).toEqual(['ai.prompts.ask.plan: the file does not exist']);
    expect(await problemsOf({ 'ask.plan': folder })).toEqual(['ai.prompts.ask.plan: the file cannot be read']);
  });

  it('refuses an id that is not a built-in prompt, naming ai.prompts and the id', async () => {
    expect(await problemsOf({ 'free.text': file('free.txt', 'x') })).toEqual(['ai.prompts: free.text is not a built-in prompt (ask.plan, summary.view, assistant.route)']);
  });

  it('reports every problem at once', async () => {
    const problems = await problemsOf({ 'free.text': file('free2.txt', 'x'), 'ask.plan': join(folder, 'nope.txt'), 'summary.view': file('empty2.txt', '') });
    expect(problems).toHaveLength(3);
  });

  it('never puts the text of an override in a problem', async () => {
    const problems = await problemsOf({ 'ask.plan': file('secretish.txt', 'SENTINEL-TEXT {{nope}}') });
    expect(problems.join('')).not.toContain('SENTINEL-TEXT');
  });
});
