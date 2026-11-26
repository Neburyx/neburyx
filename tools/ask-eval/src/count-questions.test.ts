import { cpSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { runCli } from './cli.js';
import { cleanUpTemporary } from './sets.js';
import { cleanUp, hooksWith, io, scratch } from './testing/hooks.js';

afterAll(() => {
  cleanUp();
  cleanUpTemporary();
});

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DATA = join(ROOT, 'tools', 'ask-eval', 'data', 'count-questions');
const RECORDINGS = readdirSync(DATA).filter((name) => name.endsWith('.json')).sort();

/** The requests of the recordings whose first reply gave no route to take, each of which the repeat routed: by recording, the request and why the router refuses its first reply. */
const NEEDED_THE_REPEAT: Readonly<Record<string, readonly string[]>> = {
  // the classifier's reply form, which the source's own list of questions shows and the router's reply format overrides
  'haiku-1.json': ['banking-fraud/count-accounts-on-device wrong-form'],
  'sonnet-1.json': [],
  // a route, a change of mind in words, then a second route: two objects are never read
  'sonnet-2.json': ['banking-fraud/count-transactions-total wrong-form'],
};

/** The shipped packs with the count questions in place of each pack's own router set. */
function countPacks(): string {
  const folder = scratch();
  for (const pack of ['banking-fraud', 'insurance-claims']) {
    cpSync(join(ROOT, 'domain-packs', pack), join(folder, pack), { recursive: true });
    cpSync(join(DATA, pack, 'assistant-questions.yaml'), join(folder, pack, 'assistant-questions.yaml'));
  }
  return folder;
}

async function replayed(replay: string) {
  const out = io();
  const code = await runCli(['assistant', '--packs', countPacks(), '--replay', replay], out.io, hooksWith(() => ({ failure: 'timeout' })));
  return { code, text: [...out.out, ...out.err].join('\n') };
}

describe('the count questions over the recorded live runs', () => {
  it('are recorded on both models, and every recording says which of its requests needed the repeat', () => {
    const models = new Set(RECORDINGS.map((name) => (JSON.parse(readFileSync(join(DATA, name), 'utf8')) as { model: string }).model));
    expect([...models].sort()).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5']);
    expect(RECORDINGS).toEqual(Object.keys(NEEDED_THE_REPEAT).sort());
  });

  it.each(RECORDINGS)('are routed from the first reply, in one call, all but the named ones, in %s', async (name) => {
    const { text } = await replayed(join(DATA, name));
    const named = NEEDED_THE_REPEAT[name] ?? [];
    expect(text).toContain(`requests routed from their first reply: ${20 - named.length} of 20`);
    expect(text).toContain('requests with no first reply: 0');
    expect(text).toContain(`rescued by the repeat: ${named.length}; ended unplaced: 0`);
    // a first reply that holds the route after other text is listed too, and needed no second call
    expect(text.split('\n').filter((line) => /^first reply: .* (?!text-around)\S+$/.test(line))).toEqual(named.map((entry) => `first reply: ${entry}`));
  });

  it('counts one fewer for a recording whose first reply needs a repeat, so the case above can fail', async () => {
    const replay = JSON.parse(readFileSync(join(DATA, 'sonnet-1.json'), 'utf8')) as { answers: Record<string, { reply: string }> };
    const [first] = Object.keys(replay.answers);
    if (first === undefined) throw new Error('the recording holds no reply');
    replay.answers[first] = { reply: 'No route here.' };
    const path = join(scratch(), 'replay.json');
    writeFileSync(path, JSON.stringify(replay));
    expect((await replayed(path)).text).toContain('requests routed from their first reply: 19 of 20');
  });

  it('refuses a recording made for another router text', async () => {
    const replay = JSON.parse(readFileSync(join(DATA, RECORDINGS[0] ?? ''), 'utf8')) as { folders: Record<string, string> };
    for (const source of Object.keys(replay.folders)) replay.folders[source] = 'a'.repeat(64);
    const path = join(scratch(), 'replay.json');
    writeFileSync(path, JSON.stringify(replay));
    const refused = await replayed(path);
    expect(refused.code).toBe(2);
    expect(refused.text).toContain('another router text');
  });
});
