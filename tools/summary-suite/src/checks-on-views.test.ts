import type { SummarySentence } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { caseOf, loadCases } from './cases.js';
import { NUMBER_ON_THE_SECOND } from './evidence.js';
import { defined, expectNoVerdict, expectNumbersCited, SuiteCheckFailed } from './checks.js';
import { replyOf, startRig } from './testing/rig.js';
import { expectClean, run, viewOf, type Evidence } from './rules.js';

const set = loadCases();
const PAIRS: readonly { readonly rule: string; readonly broken: (e: Evidence) => SummarySentence; readonly valid: (e: Evidence) => SummarySentence }[] = [
  {
    rule: 'a number that only an element the sentence does not cite holds',
    broken: (e) => ({ text: `The ledger shows ${NUMBER_ON_THE_SECOND}.`, cites: [e.first] }),
    valid: (e) => ({ text: `The ledger shows ${NUMBER_ON_THE_SECOND}.`, cites: [e.second] }),
  },
  {
    rule: 'an estimated count written without its label',
    broken: (e) => ({ text: 'There were 40 transfers.', cites: [e.estimated] }),
    valid: (e) => ({ text: 'There were ~40 (estimated) transfers.', cites: [e.estimated] }),
  },
  {
    rule: 'a lower bound written without its label',
    broken: (e) => ({ text: 'There were 500 transfers.', cites: [e.lowerBound] }),
    valid: (e) => ({ text: 'There were ≥ 500 (lower bound) transfers.', cites: [e.lowerBound] }),
  },
  {
    rule: 'a number, supported by another cited element, beside an unknown count',
    broken: (e) => ({ text: `There were ${NUMBER_ON_THE_SECOND} transfers.`, cites: [e.unknown, e.second] }),
    valid: (e) => ({ text: 'The number of transfers is not known.', cites: [e.unknown] }),
  },
];

describe('the rules of the checks, each with its valid control, over every view of the set', () => {
  for (const { rule, broken, valid } of PAIRS) {
    it(`removes ${rule}, and keeps the sentence that follows the rule`, async () => {
      for (const labelled of set.cases) {
        const evidence = await viewOf(labelled);
        const wrong = await run(labelled, evidence, [broken(evidence)]);
        expect(wrong.outcome.status, `${labelled.id}: ${rule}`).toBe('unsupported');
        const right = await run(labelled, evidence, [valid(evidence)]);
        expect(right.outcome.status, `${labelled.id}: control of ${rule}`).toBe('ok');
        expectClean(right.kept, right.sent);
      }
    });
  }

  it('removes a sentence that cites nothing, a key that was not sent, a name that was not sent and verdict wording, and keeps the good sentence beside each', async () => {
    for (const labelled of set.cases) {
      const evidence = await viewOf(labelled);
      const good = defined(labelled.sentences.find((sentence) => sentence.label === 'keep'), 'a keep sentence');
      const goodSentence = { text: good.text, cites: good.cites.map((key) => defined(evidence.keys.get(key), key)) };
      const invented = defined(labelled.invented_names[0], 'an invented name');
      const name = defined(labelled.entities[0], 'an entity').name;
      const breaks: readonly SummarySentence[] = [
        { text: `${name} is listed.`, cites: [] },
        { text: `${name} is listed.`, cites: ['n99'] },
        { text: `${invented} is connected.`, cites: [evidence.first] },
        { text: 'This is evidence of fraud.', cites: [evidence.first] },
      ];
      for (const bad of breaks) {
        const { outcome, kept, sent } = await run(labelled, evidence, [goodSentence, bad]);
        expect(outcome.status, `${labelled.id}: ${bad.text}`).toBe('partial');
        expect(kept).toEqual([goodSentence]);
        expectClean(kept, sent, labelled.invented_names);
      }
    }
  });

  it('keeps 12 sentences and makes a format failure of 13, on every view', async () => {
    for (const labelled of set.cases) {
      const evidence = await viewOf(labelled);
      const sentence = { text: `${defined(labelled.entities[0], 'an entity').name} is listed.`, cites: [evidence.first] };
      const twelve = await run(labelled, evidence, Array.from({ length: 12 }, () => sentence));
      expect(twelve.outcome.status, labelled.id).toBe('ok');
      expect(twelve.kept, labelled.id).toHaveLength(12);
      const thirteen = await run(labelled, evidence, Array.from({ length: 13 }, () => sentence));
      expect(thirteen.outcome, labelled.id).toMatchObject({ status: 'failed', kind: 'format' });
    }
  });
});

describe('a verdict in the reply', () => {
  it('earns a further call, and a last reply that still holds it has the sentence removed, on every view', async () => {
    for (const labelled of set.cases) {
      const evidence = await viewOf(labelled);
      const verdict = { text: 'This is evidence of fraud.', cites: [evidence.first] };
      const good = { text: `${defined(labelled.entities[0], 'an entity').name} is listed.`, cites: [evidence.first] };
      const { outcome, rig, kept } = await run(labelled, evidence, [good, verdict], 2);
      expect(rig.requests, labelled.id).toHaveLength(2);
      expect(rig.requests[1]?.values).toContain(defined(rig.requests[0], 'the first request').values);
      expect(outcome.status, labelled.id).toBe('partial');
      expectNoVerdict(kept);
    }
  });

  it('earns a further call when no sentence is left, and answers the sentences of the new reply', async () => {
    const labelled = caseOf(set, 0);
    const evidence = await viewOf(labelled);
    const rig = startRig({ replies: [replyOf({ text: 'Nothing is cited.', cites: [] }), replyOf({ text: 'The first entity is listed.', cites: [evidence.first] })], settings: { maxCalls: 3 } });
    const outcome = await rig.summarize(evidence.view);
    expect(rig.requests).toHaveLength(2);
    expect(outcome.status).toBe('ok');
  });
});

describe('the helpers of the rules cannot be removed unseen (canaries)', () => {
  const sent = 'Entities:\nn1 | "account" | title: "AC-1" | id: "AC-1" | note: "-5"\nn2 | "account" | title: "AC-2" | id: "AC-2" | ledger: "1,000"\nRelationships:\ne1 | "X" | n1 -> n2 | stored | relationships between them: not known';
  const asked = (text: string, cites: string[]): SummarySentence[] => [{ text, cites }];

  it('canary: a sentence the checks should have removed is caught, for each of the citation, number, count, name and verdict rules', () => {
    expect(() => expectClean(asked('Listed.', []), sent)).toThrow(SuiteCheckFailed);
    expect(() => expectClean(asked('Listed.', ['n9']), sent)).toThrow(SuiteCheckFailed);
    expect(() => expectClean(asked('There are 987654 records.', ['n1']), sent)).toThrow(SuiteCheckFailed);
    expect(() => expectClean(asked('There are 12 transfers.', ['e1']), sent)).toThrow(SuiteCheckFailed);
    expect(() => expectClean(asked('Mira Holt is connected.', ['n1']), sent, ['Mira Holt'])).toThrow(SuiteCheckFailed);
    expect(() => expectClean(asked('This is evidence of fraud.', ['n1']), sent)).toThrow(SuiteCheckFailed);
  });

  it('canary: a number is not supported by the digits of an id or a key, and keeps its sign and its thousands separator', () => {
    expect(() => expectNumbersCited(asked('There are 1 records.', ['n1']), sent)).toThrow(SuiteCheckFailed);
    expect(() => expectNumbersCited(asked('The note is 5.', ['n1']), sent)).toThrow(SuiteCheckFailed);
    expect(() => expectNumbersCited(asked('The note is -5.', ['n1']), sent)).not.toThrow();
    expect(() => expectNumbersCited(asked('The ledger is 1000.', ['n2']), sent)).not.toThrow();
    expect(() => expectNumbersCited(asked('The ledger is 1,000.', ['n2']), sent)).not.toThrow();
    expect(() => expectNumbersCited(asked('The account AC-1 is listed.', ['n1']), sent)).not.toThrow();
  });

  it('canary: an identifier with digits supports no number, a leading point and a plus sign are read as the checks read them', () => {
    const lines = 'Entities:\nn1 | "x" | title: "T" | id: "123ABC" | share: ".5" | balance: "+5" | other: "5"\nRelationships:\n(none)';
    expect(() => expectNumbersCited(asked('The number is 123.', ['n1']), lines)).toThrow(SuiteCheckFailed);
    expect(() => expectNumbersCited(asked('The share is .5.', ['n1']), lines)).not.toThrow();
    expect(() => expectNumbersCited(asked('The balance is 5.', ['n1']), lines)).not.toThrow();
    expect(() => expectNumbersCited(asked('The balance is +5.', ['n1']), lines)).not.toThrow();
    const share = 'Entities:\nn1 | "x" | title: "T" | id: "AC-1" | share: ".5"\nRelationships:\n(none)';
    expect(() => expectNumbersCited(asked('The share is 5.', ['n1']), share)).toThrow(SuiteCheckFailed);
  });

  it('canary: the control sentences are clean, and a count is judged only when the sentence states its number', () => {
    const counted = 'Entities:\nn1 | "a" | title: "T" | id: "AC-1"\nRelationships:\ne1 | "X" | n1 -> n1 | stored | relationships between them: ~40 (estimated)\ne2 | "Y" | n1 -> n1 | stored | relationships between them: 7 (exact)\ne3 | "Z" | n1 -> n1 | stored | relationships between them: not known';
    expect(() => expectClean(asked('The number of transfers is not known.', ['e3']), counted)).not.toThrow();
    expect(() => expectClean(asked('The accounts are linked.', ['e1']), counted)).not.toThrow();
    expect(() => expectClean(asked('There were 7 transfers.', ['e2']), counted)).not.toThrow();
    expect(() => expectClean(asked('There were 40 transfers.', ['e1']), counted)).toThrow(SuiteCheckFailed);
    expect(() => expectClean(asked('There were about ~40 (estimated) transfers.', ['e1']), counted)).not.toThrow();
  });

  it('canary: a neutral word that holds the letters of a verdict word is not wording, and a date supports its year, month and day separately', () => {
    expect(() => expectNoVerdict(asked('The provenance is listed.', ['n1']))).not.toThrow();
    expect(() => expectNoVerdict(asked('The improvement is noted.', ['n1']))).not.toThrow();
    const dated = 'Entities:\nn1 | "a" | title: "T" | id: "AC-1"\nRelationships:\ne1 | "X" | n1 -> n1 | stored | observed at "2026-09-10"';
    expect(() => expectNumbersCited(asked('The transfer was observed in 2026.', ['e1']), dated)).not.toThrow();
    expect(() => expectNumbersCited(asked('The transfer was observed in 2025.', ['e1']), dated)).toThrow(SuiteCheckFailed);
  });

  it('canary: the verdict statement reads a title of a cited element in any case and as whole words only, and still finds a verdict beside it, with a fragment of a title, or for an element that is not cited', () => {
    const titled = 'Entities:\nn1 | "a" | title: "Crimson Lake Traders" | id: "AC-9"\nn2 | "a" | title: "Ra" | id: "AC-10"\nRelationships:\n(none)';
    expect(() => expectNoVerdict(asked('crimson lake traders is listed.', ['n1']), titled)).not.toThrow();
    expect(() => expectNoVerdict(asked('Crimson Lake Traders is listed.', ['n1']), titled)).not.toThrow();
    expect(() => expectNoVerdict(asked('Crimson Lake Traders committed fraud.', ['n1']), titled)).toThrow(SuiteCheckFailed);
    expect(() => expectNoVerdict(asked('AC-10 shows fraud.', ['n2']), titled)).toThrow(SuiteCheckFailed);
    expect(() => expectNoVerdict(asked('Crimson Lake Traders is listed.', ['n2']), titled)).toThrow(SuiteCheckFailed);
    expect(() => expectNoVerdict(asked('Crimson Lake Traders is listed.', ['n1']))).toThrow(SuiteCheckFailed);
  });

  it('canary: a title is not taken out of a hyphenated word, and an id with a hyphen is one word', () => {
    const fraud = 'Entities:\nn1 | "a" | title: "Fraud" | id: "FRAUD-7"\nRelationships:\n(none)';
    expect(() => expectNoVerdict(asked('Fraud-linked transfers are listed.', ['n1']), fraud)).toThrow(SuiteCheckFailed);
    expect(() => expectNoVerdict(asked('The company FRAUD-7 is listed.', ['n1']), fraud)).not.toThrow();
    const id = 'Entities:\nn1 | "a" | title: "Plain" | id: "FRAUD-7"\nRelationships:\n(none)';
    expect(() => expectNoVerdict(asked('A fraud 7 is listed.', ['n1']), id)).toThrow(SuiteCheckFailed);
  });

  it.each(['This proves a link.', 'That is proof of it.', 'We reach a conclusion here.', 'They concluded it.', 'The holder is responsible for it.', 'The holder is responsible\nfor it.', 'It shows guilt.', 'It is an offence.'])('canary: the verdict scanner finds the wording of: %s', (text) => {
    expect(() => expectNoVerdict(asked(text, ['n1']))).toThrow(SuiteCheckFailed);
  });
});
