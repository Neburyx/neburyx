import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { configuredWith, copyOfAskFolder, demoPacks, removeDemoFolders, type DemoPack } from '../testing/demo-packs.js';

afterAll(removeDemoFolders);

const packs = demoPacks();

describe('the demo packs', () => {
  it('ship an Ask folder each', () => {
    expect(packs.length).toBeGreaterThanOrEqual(2);
  });
});

describe.each(packs.map((pack) => [pack.pack, pack] as const))('the Ask folder of the %s pack', (_name, pack: DemoPack) => {
  it('passes the start-up checks of the product, copied as it is to a folder named by the source id', async () => {
    const { outcome, extension } = await configuredWith(copyOfAskFolder(pack), [pack.sourceId]);
    expect(outcome).toEqual({ ok: true });
    expect(extension.askFolder?.()?.sourceIds).toEqual([pack.sourceId]);
  });

  it('holds an intent for every question that expects one, with the inputs the question gives, and no intent that no question names', () => {
    const named = new Set<string>();
    for (const question of pack.questions) {
      if (question.expect === 'refuse') continue;
      const intent = pack.intents[question.expect.intent];
      expect(intent, question.id).toBeDefined();
      expect(Object.keys(question.expect.entities).sort(), question.id).toEqual([...(intent?.parameters ?? [])].sort());
      named.add(question.expect.intent);
    }
    expect([...Object.keys(pack.intents)].filter((name) => !named.has(name))).toEqual([]);
  });

  it('names the reserved intent saved-pattern with its two inputs, which the folder does not hold as an intent of its own', () => {
    const text = readFileSync(join(pack.dir, 'ask', 'classification.md'), 'utf8');
    const line = text.split('\n').find((row) => row.startsWith('- `saved-pattern`'));
    expect(line).toContain('(inputs: pattern, anchor)');
    expect(Object.keys(pack.intents)).not.toContain('saved-pattern');
  });

  it('keeps every number, window and limit out of a placeholder: a placeholder stands for text the question gives', () => {
    for (const [name, intent] of Object.entries(pack.intents)) {
      if (intent.template === undefined) continue;
      const placeholders = [...JSON.stringify(intent.settings).matchAll(/"\$([A-Za-z0-9_]+)"/g)].map((match) => match[1]);
      expect([...new Set(placeholders)].sort(), name).toEqual([...intent.parameters].sort());
      expect(JSON.stringify(intent.settings), name).not.toMatch(/"(days|limit|minShared|maxHops)":"\$/);
    }
  });

  it('tells the model the reply form and each intent, and answers no intent for what no line answers', () => {
    const text = readFileSync(join(pack.dir, 'ask', 'classification.md'), 'utf8');
    expect(text).toContain('exactly one JSON object');
    expect(text).toContain('"intent"');
    expect(text).toContain('"entities"');
    for (const name of Object.keys(pack.intents)) expect(text, name).toContain(`\`${name}\``);
    expect(text).toContain('null');
  });

  it('is stopped by the loader when a placeholder is not one of the intent\'s parameters, naming the intent', async () => {
    const [name, intent] = Object.entries(pack.intents).find(([, found]) => found.template !== undefined) ?? [];
    expect(name).toBeDefined();
    const folder = copyOfAskFolder(pack, (subfolder) => {
      const broken = { ...pack.intents, [name ?? '']: { ...intent, parameters: [...(intent?.parameters ?? []), 'extra'] } };
      writeFileSync(join(subfolder, 'intents.json'), JSON.stringify(broken));
    });
    const { outcome } = await configuredWith(folder, [pack.sourceId]);
    expect(outcome?.ok).toBe(false);
    expect(JSON.stringify(outcome)).toContain(name ?? '');
  });

  it('is stopped by the loader when a query writes, naming the intent', async () => {
    const [name, intent] = Object.entries(pack.intents).find(([, found]) => found.query !== undefined) ?? [];
    expect(name).toBeDefined();
    const folder = copyOfAskFolder(pack, (subfolder) => {
      writeFileSync(join(subfolder, 'intents.json'), JSON.stringify({ ...pack.intents, [name ?? '']: { ...intent, query: `${intent?.query ?? ''} SET c.touched = true` } }));
    });
    const { outcome } = await configuredWith(folder, [pack.sourceId]);
    expect(outcome?.ok).toBe(false);
    expect(JSON.stringify(outcome)).toContain(name ?? '');
  });

  it('holds file queries with no LIMIT below the row cap, one parameter, and read-only text', () => {
    for (const [name, intent] of Object.entries(pack.intents)) {
      if (intent.query === undefined) continue;
      expect(intent.query, name).not.toMatch(/\bLIMIT\b/i);
      expect(intent.parameters, name).toEqual(['name']);
      expect(intent.query, name).not.toMatch(/\b(CREATE|MERGE|DELETE|SET|REMOVE|CALL)\b/i);
    }
  });
});

describe('the questions of the packs together', () => {
  it('hold the 33 questions of the old set and the two name questions, 35 in all, 8 of them to refuse', () => {
    const all = packs.flatMap((pack) => pack.questions);
    expect(all).toHaveLength(35);
    expect(all.filter((question) => question.expect === 'refuse')).toHaveLength(8);
    expect(new Set(all.map((question) => question.wording)).size).toBe(35);
  });
});
