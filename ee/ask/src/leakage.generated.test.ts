import { describe, expect, it } from 'vitest';
import { generateQuestions, type GeneratedQuestion } from './testing/question-generator.js';
import { assertReach, baselineRequest, leakyBuilder, leaksIn, runRig, widgetRef } from './testing/leakage-rig.js';

const GENERATED_QUESTIONS = 240;
const SEED = 20261113;
/** The least share of the generated questions that must reach the model, so a generator that is blocked every time fails. */
const MIN_REACHING_SHARE = 0.5;
const TIME_LIMIT_MS = 30_000;

const knownOf = (question: GeneratedQuestion) => Object.fromEntries(Object.entries(question.known).map(([text, id]) => [text, [widgetRef(id)]]));

describe('generated questions', () => {
  it('gives the same questions for the same seed, and different ones for another', () => {
    expect(generateQuestions(SEED, 20).map((q) => q.message)).toEqual(generateQuestions(SEED, 20).map((q) => q.message));
    expect(generateQuestions(SEED + 1, 20).map((q) => q.message)).not.toEqual(generateQuestions(SEED, 20).map((q) => q.message));
    expect(GENERATED_QUESTIONS).toBeGreaterThanOrEqual(200);
  });

  it('puts no typed name, ID, email or long number in any request, and enough of the questions reach the model', async () => {
    const started = Date.now();
    const baseline = await baselineRequest();
    const questions = generateQuestions(SEED, GENERATED_QUESTIONS);
    let reached = 0;
    for (const [index, question] of questions.entries()) {
      const run = await runRig(question.message, { known: knownOf(question) });
      try {
        if (!question.blocked) assertReach(run, true);
        else assertReach(run, false);
        expect(leaksIn(run.requests, question.tokens, baseline)).toEqual([]);
      } catch (error) {
        // the seed and the shape of the question, never a token
        throw new Error(`seed ${SEED}, question ${index}, shape ${question.shape.join('+')}: ${error instanceof Error ? error.message.replace(/\n[\s\S]*/, '') : 'failed'}`);
      }
      if (run.requests.length > 0) reached += 1;
    }
    expect(reached / questions.length).toBeGreaterThanOrEqual(MIN_REACHING_SHARE);
    expect(Date.now() - started).toBeLessThan(TIME_LIMIT_MS);
  });

  it('fails on a leaky builder, so the generated check can tell', async () => {
    const baseline = await baselineRequest();
    const question = generateQuestions(SEED, GENERATED_QUESTIONS).find((candidate) => !candidate.blocked);
    if (question === undefined) throw new Error('no question to leak');
    const run = await runRig(question.message, { known: knownOf(question), wrapBuilder: leakyBuilder(question.message) });
    expect(leaksIn(run.requests, question.tokens, baseline).length).toBeGreaterThan(0);
  });
});
