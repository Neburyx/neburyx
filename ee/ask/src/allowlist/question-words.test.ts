import { aiSettingsSchema, askPlanRequestSchema } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { checkQuestionWords, runQuestionWordsCommand, type CommandIo } from './question-words.js';
import { rebuildPlannerText } from './rebuild.js';

const LABEL = 'Other words:';
const COMMON = ['as', 'same', 'the', 'which', 'in'];

function command(args: readonly string[], files: Readonly<Record<string, string>>) {
  let out = '';
  let err = '';
  const io: CommandIo = {
    stdout: (text) => (out += text),
    stderr: (text) => (err += text),
    readText: (path) => {
      const text = files[path];
      if (text === undefined) throw new Error('missing');
      return text;
    },
  };
  const code = runQuestionWordsCommand(args, io);
  return { code, out, err };
}

const FILES = { 'words.txt': COMMON.join('\n'), 'vocabulary.txt': 'Widget\nGadget' };
const withLine = (line: string) => ({ ...FILES, 'questions.md': `- Wording: a question\n- ${LABEL} ${line}\n` });
const ARGS = ['questions.md', '--label', LABEL, '--common-words', 'words.txt', '--vocabulary', 'vocabulary.txt'];

describe('the question word check', () => {
  it('fails with a plain message for a file that does not exist, and for a file with no line of the label', () => {
    expect(command(ARGS, FILES)).toMatchObject({ code: 1, err: 'a file could not be read\n', out: '' });
    expect(command(ARGS, { ...FILES, 'questions.md': 'nothing here\n' })).toMatchObject({ code: 1, err: 'the file has no line with the label\n' });
  });

  it('exits 2 with the usage for missing arguments', () => {
    expect(command(['questions.md'], FILES)).toMatchObject({ code: 2 });
    expect(command([...ARGS, 'second.md'], FILES)).toMatchObject({ code: 2 });
    expect(command(['questions.md', '--label', '', '--common-words', 'words.txt'], FILES)).toMatchObject({ code: 2 });
  });

  it('exits non-zero and prints a word that is not on the list', () => {
    expect(command(ARGS, withLine('as, same, zorvath, the'))).toEqual({ code: 1, out: '1 misses\nzorvath\n', err: '' });
  });

  it('prints only the number of misses with the count-only flag', () => {
    expect(command([...ARGS, '--count-only'], withLine('as, zorvath, qwx'))).toEqual({ code: 1, out: '2 misses\n', err: '' });
  });

  it('counts a token the rebuild blocks as a miss, with the same matcher', () => {
    const result = checkQuestionWords({ fileText: `${LABEL} day, 2025, widgets`, label: LABEL, vocabulary: ['Widget'], commonWords: COMMON });
    expect(result.misses).toEqual(['day', '2025']);
    for (const word of result.misses) expect(rebuildPlannerText({ text: word, spans: [], vocabulary: ['Widget'], commonWords: COMMON }).kind).toBe('blocked');
  });

  it('exits 0 with 0 misses when every word is listed, a form of a vocabulary word or in a window phrase', () => {
    expect(command(ARGS, withLine('as, the, widgets, gadgets; window phrase: in the last 30 days'))).toEqual({ code: 0, out: '0 misses\n', err: '' });
  });

  it('reports a word of the window phrase that the grammar does not allow', () => {
    expect(command(ARGS, withLine('as; window phrase: last 30 dayz'))).toMatchObject({ code: 1, out: '2 misses\nlast\ndayz\n' });
  });
});

describe('no way to send a token that is not allowed', () => {
  it('refuses an ai setting that would allow words, as an unknown key', () => {
    expect(aiSettingsSchema.safeParse({ allow_words: ['zorvath'] }).success).toBe(false);
    expect(aiSettingsSchema.safeParse({ preview: true }).success).toBe(true);
  });

  it('refuses an extra field of the Ask plan request', () => {
    expect(askPlanRequestSchema.safeParse({ message: 'which widgets', allowWords: ['zorvath'] }).success).toBe(false);
    expect(askPlanRequestSchema.safeParse({ message: 'which widgets' }).success).toBe(true);
  });

  it('blocks a word that an extra option of the rebuild names, because the rebuild has no such option', () => {
    const input = { text: 'which zorvath', spans: [], vocabulary: [], commonWords: ['which'], allowWords: ['zorvath'], allow: ['zorvath'] };
    expect(rebuildPlannerText(input)).toEqual({ kind: 'blocked', tokens: [{ text: 'zorvath', start: 6, end: 13 }] });
  });
});
