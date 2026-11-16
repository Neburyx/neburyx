import { renderForExport } from '@neburyx/ee-ask';
import { describe, expect, it } from 'vitest';
import { loadCases } from './cases.js';
import { defined } from './checks.js';
import { mutatedModule, type Mutation } from './mutants.js';
import { drafted, withMaskedValues } from './testing/export.js';

const set = loadCases();

type Render = typeof renderForExport;
/** What a scenario answers, as the texts of the sentences an export carries (or `refused`), given the export function to use. */
type Scenario = (render: Render) => Promise<readonly string[] | string>;

const view = async (id: string, masked?: boolean) => drafted(defined(set.cases.find((each) => each.id === id), id), masked);

/** The sentences carried by an export, or the refusal; a thrown error is told apart as such, since the changed source may fail in a way the product does not. */
const textsOf = (answer: ReturnType<Render>): readonly string[] | string => (answer.status === 'ok' ? answer.section.sentences.map((sentence) => sentence.text) : 'refused');

const RULES: { readonly name: string; readonly mutation: Mutation; readonly scenario: Scenario; readonly whole: (texts: readonly string[]) => unknown; readonly weakened: (texts: readonly string[]) => unknown; readonly count: number }[] = [
  {
    name: 'a sentence with a cite that the export does not hold, after cites that it holds',
    mutation: { name: 'the unresolved cite', from: 'if (!whole) continue;', to: '' },
    scenario: async (render) => {
      const { evidence, render: renderFor } = await view('ring-on-one-device');
      const last = defined(evidence.view.edges.find((edge) => 'stableId' in edge.ref && edge.ref.stableId === 'r6'), 'the last relationship');
      return textsOf(renderFor({ ...evidence.view, edges: evidence.view.edges.filter((edge) => edge !== last), omitted: true }, { render }));
    },
    whole: (texts) => [texts[0]],
    weakened: (texts) => texts,
    count: 2,
  },
  {
    name: 'the judgement of a kept sentence against the export\'s own reading',
    mutation: { name: 'the judgement', from: 'const [judged] = judgeSentences([{ text: sentence.text, cites: current }], assembled).kept;', to: 'const judged = { text: sentence.text, cites: current };' },
    scenario: async (render) => {
      const { evidence, render: renderFor } = await view('same-text-different-addresses', true);
      return textsOf(renderFor(withMaskedValues(evidence.view), { render }));
    },
    whole: (texts) => [texts[0]],
    weakened: (texts) => texts,
    count: 2,
  },
  {
    name: 'a draft written unmasked, for an export that masks a property',
    mutation: { name: 'the masked property', from: 'for (const sentence of draftedBeforeMasking ? [] : payload.sentences) {', to: 'for (const sentence of payload.sentences) {' },
    scenario: async (render) => {
      const { evidence, render: renderFor } = await view('same-text-different-addresses');
      return textsOf(renderFor(withMaskedValues(evidence.view), { render }));
    },
    whole: () => [],
    weakened: (texts) => texts,
    count: 1,
  },
];

describe('a rule of the export taken out of the product leaves a sentence carried, and the suite fails on it', () => {
  it.each(RULES)('fails the suite when the source of the export no longer tests $name, and passes it with the product as it is', async (rule) => {
    const mutant = await mutatedModule('export-render.ts', rule.mutation);
    const whole = await rule.scenario(renderForExport);
    const weakened = await rule.scenario(mutant['renderForExport'] as Render);
    expect(Array.isArray(weakened) && weakened.length, 'the sentences of the changed copy').toBe(rule.count);
    expect(weakened).toEqual(rule.weakened(weakened as string[]));
    expect(whole).toEqual(rule.whole(weakened as string[]));
    expect(whole).not.toEqual(weakened);
  });

  it('shows the removal of the refusal of an unusable token as an unhandled error, never as a token accepted, and passes it with the product as it is', async () => {
    const mutant = await mutatedModule('export-render.ts', { name: 'the refusal', from: "if (!opened.ok) return { status: 'refused' };", to: '' });
    const { evidence, render } = await view('ring-on-one-device');
    expect(render(evidence.view, { actorId: 'someone-else' })).toEqual({ status: 'refused' });
    expect(() => render(evidence.view, { actorId: 'someone-else', render: mutant['renderForExport'] as Render })).toThrow(TypeError);
  });
});
