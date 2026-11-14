import { describe, expect, it } from 'vitest';
import { readQuestions, UsageError } from './questions.js';
import { loadSets } from './sets.js';
import { cleanUp, fixtureSet, hooksWith, QUESTIONS } from './testing/hooks.js';
import { afterAll } from 'vitest';

afterAll(cleanUp);

describe('reading a question file', () => {
  it.each([
    ['text that is not YAML', 'questions: [\n'],
    ['an unknown key', 'questions:\n  - { id: a, wording: x, expect: refuse, extra: 1 }\n'],
    ['an id used twice', 'questions:\n  - { id: a, wording: x, expect: refuse }\n  - { id: a, wording: y, expect: refuse }\n'],
    ['an empty wording', 'questions:\n  - { id: a, wording: "  ", expect: refuse }\n'],
    ['a wording over 1,000 code points', `questions:\n  - { id: a, wording: "${'x'.repeat(1001)}", expect: refuse }\n`],
    ['an entity that is not text', 'questions:\n  - { id: a, wording: x, expect: { intent: i, entities: { id: 5 } } }\n'],
  ])('refuses %s, naming the id or the place and never a wording', (_name, text) => {
    expect(() => readQuestions(text)).toThrow(UsageError);
    try {
      readQuestions(text);
    } catch (error) {
      expect(String(error)).not.toContain('Show thing');
    }
  });

  it('reads a refusal and a plan', () => {
    expect(readQuestions(QUESTIONS).map((question) => question.id)).toEqual(['q1', 'q2', 'q3']);
  });
});

describe('checking the questions against their folder', () => {
  const load = async (yaml: string) => {
    const fixture = fixtureSet(yaml);
    return loadSets({ questions: fixture.questions, folder: fixture.folder, source: fixture.source }, hooksWith(() => ({ failure: 'timeout' })));
  };

  it('accepts questions whose intents and entities the folder has', async () => {
    expect((await load(QUESTIONS)).flatMap((set) => set.questions)).toHaveLength(3);
  });

  it('refuses an expected intent the folder does not have, naming the question', async () => {
    await expect(load('questions:\n  - { id: a, wording: x, expect: { intent: nope, entities: { id: T-1 } } }\n')).rejects.toThrow(/fixture-source\/a expects an intent that the folder does not have/);
  });

  it('refuses expected entity names that are not exactly the parameters of the intent', async () => {
    await expect(load('questions:\n  - { id: a, wording: x, expect: { intent: byId, entities: { id: T-1, more: T-2 } } }\n')).rejects.toThrow(/not exactly the parameters/);
    await expect(load('questions:\n  - { id: a, wording: x, expect: { intent: pair, entities: { first: T-1 } } }\n')).rejects.toThrow(/not exactly the parameters/);
  });

  it('refuses a wording used twice in the set', async () => {
    await expect(load('questions:\n  - { id: a, wording: same, expect: refuse }\n  - { id: b, wording: same, expect: refuse }\n')).rejects.toThrow(/used by another question/);
  });

  it('refuses a question file inside a git working tree for a private run', async () => {
    const fixture = fixtureSet(QUESTIONS);
    const { mkdirSync } = await import('node:fs');
    mkdirSync(`${fixture.root}/.git`);
    await expect(loadSets({ questions: fixture.questions, folder: fixture.folder, source: fixture.source }, hooksWith(() => ({ failure: 'timeout' })))).rejects.toThrow(/inside a git working tree/);
  });
});
