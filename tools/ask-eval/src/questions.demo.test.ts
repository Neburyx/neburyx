import { createEvalPlanner } from '../../../ee/ask/dist/eval/replay-planner.js';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadMapping } from './mapping-view.js';
import { KNOWN_BLOCKED } from './testing/known-blocked.js';
import { loadQuestions } from './questions.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const FILE = join(ROOT, 'services', 'api', 'tests', 'ask', 'questions.yaml');
const questions = loadQuestions(FILE);

describe('the demo question file', () => {
  it('holds 33 questions: 25 expecting a plan and 8 expecting a refusal, each with a pack', () => {
    expect(questions).toHaveLength(33);
    expect(questions.filter((question) => question.expect.kind === 'plan')).toHaveLength(25);
    expect(questions.filter((question) => question.expect.kind === 'unsupported')).toHaveLength(8);
    expect(questions.every((question) => question.pack === 'banking-fraud' || question.pack === 'insurance-claims')).toBe(true);
  });

  it('expects the value placeholder for the payment reference and a refusal for the two questions about the loaded view', () => {
    const search = questions.find((question) => question.expect.kind === 'plan' && question.expect.template === 'search');
    expect(search?.expect).toMatchObject({ params: { text: '‹value#1›' } });
    expect(questions.find((question) => question.id === 'accounts-on-screen')?.expect.kind).toBe('unsupported');
    expect(questions.find((question) => question.id === 'claimant-with-the-most-claims')?.expect.kind).toBe('unsupported');
  });

  it('holds no question number, group label, note or planning identifier', () => {
    const text = readFileSync(FILE, 'utf8');
    expect(text).not.toMatch(/\b[QAFG]\d{1,3}\b/);
    expect(text).not.toMatch(/\b(?:EP|OD|DM|B)-\d+/);
    expect(text).not.toMatch(/\b(?:finding|note|family)\s*[A-Z]?\d/i);
  });

  it('gives the planner a text for every wording but the known blocked ones, with the vocabulary of its own pack', async () => {
    const blocked: string[] = [];
    for (const pack of ['banking-fraud', 'insurance-claims']) {
      const planner = await createEvalPlanner({ view: loadMapping(join(ROOT, 'domain-packs', pack, 'neburyx.yaml')).view, replay: {} });
      blocked.push(...questions.filter((question) => question.pack === pack && planner.rebuild(question.wording) === undefined).map((question) => question.id));
    }
    expect(blocked.sort()).toEqual([...KNOWN_BLOCKED].sort());
  });
});
