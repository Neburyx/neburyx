import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAskFolder } from './load.js';

const made: string[] = [];
afterEach(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
});

const QUERY = 'MATCH (n) WHERE n.id = $id RETURN n LIMIT 5';
const INTENTS = JSON.stringify({ byId: { parameters: ['id'], query: QUERY }, shared: { parameters: ['id'], template: 'shared-attribute', settings: { ref: { entityType: 'widget', stableId: '$id' }, attributeType: 'shape', via: 'USES_SHAPE' } } });
const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** A folder with a subfolder for each id in `sources`, each holding the two files unless `files` says otherwise. */
function folderWith(sources: Readonly<Record<string, Readonly<Record<string, string>> | undefined>>, top: Readonly<Record<string, string>> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'ask-folder-'));
  made.push(root);
  for (const [id, files] of Object.entries(sources)) {
    mkdirSync(join(root, id));
    for (const [name, text] of Object.entries(files ?? { 'classification.md': 'Choose an intent.', 'intents.json': INTENTS })) writeFileSync(join(root, id, name), text);
  }
  for (const [name, text] of Object.entries(top)) writeFileSync(join(root, name), text);
  return root;
}

const problemsOf = async (folder: string, sourceIds: readonly string[] = ['demo']): Promise<readonly string[]> => {
  const loaded = await loadAskFolder({ folder, sourceIds });
  return loaded.ok ? [] : loaded.problems;
};

describe('the Ask folder', () => {
  it('is read once per source: the classification text and its hash, and each intent in file order with its query hash', async () => {
    const root = folderWith({ demo: undefined, other: undefined }, { '.DS_Store': 'x' });
    const loaded = await loadAskFolder({ folder: root, sourceIds: ['demo', 'other', 'third'] });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.folder.sourceIds).toEqual(['demo', 'other']);
    expect(loaded.folder.source('third')).toBeUndefined();
    const demo = loaded.folder.source('demo');
    expect(demo?.classification).toEqual({ text: 'Choose an intent.', sha256: sha('Choose an intent.') });
    expect(demo?.intents.map((intent) => intent.name)).toEqual(['byId', 'shared']);
    expect(loaded.folder.intent('demo', 'byId')).toEqual({ name: 'byId', parameters: ['id'], kind: 'query', query: { text: QUERY, sha256: sha(QUERY) } });
    expect(loaded.folder.intent('demo', 'shared')).toMatchObject({ kind: 'template', template: 'shared-attribute', settings: { ref: { entityType: 'widget', stableId: '$id' }, attributeType: 'shape', via: 'USES_SHAPE' } });
    expect(loaded.folder.intent('demo', 'missing')).toBeUndefined();
    expect(Object.isFrozen(loaded.folder)).toBe(true);
    expect(Object.isFrozen(demo?.intents)).toBe(true);
  });

  it('does not read a file again: a change after the load is not seen', async () => {
    const root = folderWith({ demo: undefined });
    const loaded = await loadAskFolder({ folder: root, sourceIds: ['demo'] });
    writeFileSync(join(root, 'demo', 'classification.md'), 'changed');
    expect(loaded.ok && loaded.folder.source('demo')?.classification.text).toBe('Choose an intent.');
  });

  it('hashes the exact bytes of the file, whatever the line endings', async () => {
    const text = 'Line one\r\nLine two\n';
    const root = folderWith({ demo: { 'classification.md': text, 'intents.json': INTENTS } });
    const loaded = await loadAskFolder({ folder: root, sourceIds: ['demo'] });
    expect(loaded.ok && loaded.folder.source('demo')?.classification.sha256).toBe(sha(text));
  });

  it('names the setting for a folder that is missing or not a folder', async () => {
    expect((await problemsOf(join(tmpdir(), 'no-such-ask-folder-xyz'))).join(' ')).toContain('NEBURYX_ASK_MAPPING_FOLDER: the folder does not exist');
    const root = folderWith({}, { file: 'x' });
    expect((await problemsOf(join(root, 'file'))).join(' ')).toContain('the path is not a folder');
  });

  it('takes an empty folder when no source is configured, and refuses a subfolder then', async () => {
    const loaded = await loadAskFolder({ folder: folderWith({}), sourceIds: [] });
    expect(loaded.ok && loaded.folder.sourceIds).toEqual([]);
    expect((await problemsOf(folderWith({ demo: undefined }), [])).join(' ')).toContain('demo: not the id of a configured source');
  });

  it('refuses a folder with no subfolder for any configured source, a subfolder that is not a source and a file at the top', async () => {
    expect((await problemsOf(folderWith({}))).join(' ')).toContain('no subfolder for any configured source');
    expect((await problemsOf(folderWith({ demo: undefined, typo: undefined }))).join(' ')).toContain('NEBURYX_ASK_MAPPING_FOLDER/typo: not the id of a configured source');
    expect((await problemsOf(folderWith({ demo: undefined }, { 'README.md': 'x' }))).join(' ')).toContain('README.md: not the id of a configured source');
  });

  it('refuses a file larger than its limit without reading it all, and a file that is a folder', async () => {
    const root = folderWith({ demo: undefined });
    writeFileSync(join(root, 'demo', 'intents.json'), 'x'.repeat(1024 * 1024 + 5));
    expect((await problemsOf(root)).join(' ')).toContain('intents.json: the file is larger than 1048576 bytes');
    const second = folderWith({ demo: undefined });
    rmSync(join(second, 'demo', 'intents.json'));
    mkdirSync(join(second, 'demo', 'intents.json'));
    expect((await problemsOf(second)).join(' ')).toContain('intents.json: must be a regular file');
  });

  it('prints a name from the folder only when it is plain', async () => {
    const root = folderWith({ demo: undefined });
    writeFileSync(join(root, 'bad\u001b[31mname'), 'x');
    const problems = (await problemsOf(root)).join(' ');
    expect(problems).toContain('(a name with unusual characters): not the id of a configured source');
    expect(problems).not.toContain('\u001b');
  });

  it('refuses a missing file, another file in a source folder and a link', async () => {
    expect((await problemsOf(folderWith({ demo: { 'intents.json': INTENTS } }))).join(' ')).toContain('demo/classification.md: the file is missing');
    expect((await problemsOf(folderWith({ demo: { 'classification.md': 'x', 'intents.json': INTENTS, 'notes.txt': 'x' } }))).join(' ')).toContain('demo/notes.txt: not a file of an Ask folder');
    const root = folderWith({ demo: undefined });
    writeFileSync(join(root, 'real.md'), 'x');
    symlinkSync(join(root, 'real.md'), join(root, 'demo', 'extra-link'));
    expect((await problemsOf(root)).join(' ')).toContain('demo/extra-link: a link is not allowed');
  });

  it('refuses a linked file and a linked subfolder', async () => {
    const root = folderWith({ demo: undefined });
    const outside = mkdtempSync(join(tmpdir(), 'ask-outside-'));
    made.push(outside);
    writeFileSync(join(outside, 'classification.md'), 'x');
    rmSync(join(root, 'demo', 'classification.md'));
    symlinkSync(join(outside, 'classification.md'), join(root, 'demo', 'classification.md'));
    expect((await problemsOf(root)).join(' ')).toContain('demo/classification.md: a link is not allowed');
    const second = folderWith({});
    symlinkSync(outside, join(second, 'demo'));
    expect((await problemsOf(second)).join(' ')).toContain('demo: a link is not allowed');
  });

  it('refuses a file that is too large or not UTF-8, and a file of intents with a bad query, naming the intent and not the text', async () => {
    expect((await problemsOf(folderWith({ demo: { 'classification.md': 'x'.repeat(64 * 1024 + 1), 'intents.json': INTENTS } }))).join(' ')).toContain('classification.md: the file is larger than');
    const root = folderWith({ demo: undefined });
    writeFileSync(join(root, 'demo', 'classification.md'), Buffer.from([0xff, 0xfe, 0x41]));
    expect((await problemsOf(root)).join(' ')).toContain('classification.md: the file is not valid UTF-8 text');
    const bad = JSON.stringify({ wipe: { parameters: [], query: "MATCH (n) WHERE n.x = 'SENTINEL_TEXT' DETACH DELETE n" } });
    const problems = await problemsOf(folderWith({ demo: { 'classification.md': 'x', 'intents.json': bad } }));
    expect(problems.join(' ')).toContain('intents.json: intent "wipe"');
    expect(problems.join(' ')).not.toContain('SENTINEL_TEXT');
  });
});

describe('the path intents of the Ask folder', () => {
  const pathIntent = (settings: Record<string, unknown>) =>
    JSON.stringify({ between: { parameters: ['a', 'b'], template: 'shortest-paths', settings: { ends: [{ entityType: 'widget', stableId: '$a' }, { entityType: 'widget', stableId: '$b' }], relTypes: ['LINKS'], maxHops: 3, limit: 5, ...settings } } });
  const folderOf = (settings: Record<string, unknown>): string => folderWith({ demo: { 'classification.md': 'Choose an intent.', 'intents.json': pathIntent(settings) } });
  const BUDGETS = { demo: { maxHops: 4, pathResultsCap: 25, maxPage: 50 } };
  const problemsWith = async (settings: Record<string, unknown>, budgets: Parameters<typeof loadAskFolder>[0]['budgets'] = BUDGETS): Promise<readonly string[]> => {
    const loaded = await loadAskFolder({ folder: folderOf(settings), sourceIds: ['demo'], ...(budgets === undefined ? {} : { budgets }) });
    return loaded.ok ? [] : loaded.problems;
  };

  it.each([[{ maxHops: 5 }, 'maxHops'], [{ limit: 26 }, 'limit']])('refuses an intent above the ceilings of the product (%j), naming the intent and the setting', async (settings, name) => {
    const problems = await problemsWith(settings);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('intent "between"');
    expect(problems[0]).toContain(name);
  });

  it.each([[{ maxHops: 4, limit: 25 }], [{ maxHops: 1, limit: 1 }]])('starts with an intent at the edge of the ceilings (%j)', async (settings) => {
    expect(await problemsWith(settings)).toEqual([]);
  });

  it('refuses a number given as a placeholder', async () => {
    const problems = await problemsWith({ maxHops: '$hops' });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.every((problem) => problem.includes('intent "between"'))).toBe(true);
  });

  it('refuses an intent above its own source’s max_hops, path_results_cap or max_page, naming the intent and the limit', async () => {
    expect((await problemsWith({ maxHops: 3 }, { demo: { maxHops: 2, pathResultsCap: 25, maxPage: 50 } }))[0]).toContain('max_hops (2)');
    expect((await problemsWith({ limit: 20 }, { demo: { maxHops: 4, pathResultsCap: 10, maxPage: 50 } }))[0]).toContain('(10)');
    expect((await problemsWith({ limit: 20 }, { demo: { maxHops: 4, pathResultsCap: 25, maxPage: 10 } }))[0]).toContain('(10)');
  });

  it('starts with an intent within its source’s limits, and checks nothing of the source when it is given no budgets (scoring)', async () => {
    expect(await problemsWith({ maxHops: 3, limit: 10 }, { demo: { maxHops: 3, pathResultsCap: 10, maxPage: 10 } })).toEqual([]);
    expect(await problemsWith({ maxHops: 3, limit: 20 }, undefined)).toEqual([]);
  });

  it('checks an intent against the budgets of its own source only', async () => {
    const loaded = await loadAskFolder({ folder: folderOf({ maxHops: 3 }), sourceIds: ['demo'], budgets: { other: { maxHops: 1, pathResultsCap: 1, maxPage: 1 } } });
    expect(loaded.ok).toBe(true);
  });

  it('holds no value of a file in the problem it reports', async () => {
    const problems = await problemsWith({ maxHops: 3, relTypes: ['SECRET_TYPE'], limit: 20 }, { demo: { maxHops: 4, pathResultsCap: 10, maxPage: 50 } });
    expect(JSON.stringify(problems)).not.toContain('SECRET_TYPE');
  });
});
