import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COMMON_WORDS, COMMON_WORDS_NOTE } from './allowlist/common-words.js';
import { assertReach, baselineRequest, leakyBuilder, leaksIn, runRig, widgetRef, type TypedToken } from './testing/leakage-rig.js';

interface FixtureQuestion {
  readonly message: string;
  readonly known: Readonly<Record<string, string>>;
  readonly tokens: readonly TypedToken[];
  readonly reachesModel: boolean;
}
interface Kept {
  readonly message: string;
  readonly why: string;
  readonly text: string;
}

const FILE = fileURLToPath(new URL('../../../services/api/tests/ask/fixtures/leakage-questions.json', import.meta.url));
const fixtures = JSON.parse(readFileSync(FILE, 'utf8')) as { readonly questions: readonly FixtureQuestion[]; readonly kept: readonly Kept[] };
const knownOf = (known: Readonly<Record<string, string>>) => Object.fromEntries(Object.entries(known).map(([text, id]) => [text, [widgetRef(id)]]));

describe('fixture questions', () => {
  it('put no typed token in any request, and end where the fixture says', async () => {
    const baseline = await baselineRequest();
    expect(fixtures.questions.length).toBeGreaterThan(5);
    for (const [index, question] of fixtures.questions.entries()) {
      const run = await runRig(question.message, { known: knownOf(question.known) });
      assertReach(run, question.reachesModel);
      expect(leaksIn(run.requests, question.tokens, baseline), `fixture ${index}`).toEqual([]);
    }
  });

  it('fail when the builder is leaky, so the fixtures can tell', async () => {
    const baseline = await baselineRequest();
    const reaching = fixtures.questions.filter((question) => question.reachesModel);
    for (const question of reaching) {
      const run = await runRig(question.message, { known: knownOf(question.known), wrapBuilder: leakyBuilder(question.message) });
      expect(leaksIn(run.requests, question.tokens, baseline).length).toBeGreaterThan(0);
    }
  });

  it('keeps a number of three digits or fewer and a full calendar date in the request: the allowlist keeps them, a documented residual risk (a full date can be a date of birth)', async () => {
    for (const kept of fixtures.kept) {
      const run = await runRig(kept.message);
      assertReach(run, true);
      // read in the question the model is given, never in the whole request, whose catalog and vocabulary hold such numbers and words themselves
      expect(String(run.requests[0]?.parameters.question), kept.why).toContain(kept.text);
    }
  });

  it('keeps a given name that is also a word of the common-word list: the note says given names are not yet removed', async () => {
    expect(COMMON_WORDS_NOTE).toContain('Given names: not yet removed');
    const onTheList = ['will', 'may', 'mark', 'june', 'april', 'hope', 'grace'].filter((word) => COMMON_WORDS.includes(word));
    expect(onTheList.length, 'at least one such word is on the list today').toBeGreaterThan(0);
    for (const name of onTheList) {
      const run = await runRig(`which are the same as ${name}`);
      assertReach(run, true);
      expect(String(run.requests[0]?.parameters.question).toLowerCase(), 'a listed word is kept as the word').toContain(name);
    }
  });
});
