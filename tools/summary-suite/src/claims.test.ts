import { afterEach, describe, expect, it, vi } from 'vitest';
import { keyMapOf, loadCases, readingOf, type LabelledCase } from './cases.js';
import { mutatedChecks, type Mutation } from './mutants.js';
import { replyOf, startRig } from './testing/rig.js';
import { node, reading } from './view.js';

const set = loadCases();

afterEach(() => {
  vi.doUnmock('../../../ee/ask/src/case-summary/checks.js');
  vi.resetModules();
});

const NO_BACKING_OF_CLAIMS: Mutation = {
  name: 'the backing of the claims of a sentence',
  from: 'absenceHolds(sentence, assembled) && universalHolds(sentence, assembled) && readDescribedHolds(sentence, assembled)',
  to: 'true',
};

/** The groups of one type with two or more elements in a labelled view, by the keys the sent text gave them. */
function groupsOf(view: LabelledCase, keys: ReadonlyMap<string, string>): { readonly type: string; readonly cites: string[] }[] {
  const byType = new Map<string, string[]>();
  for (const entity of view.entities) byType.set(entity.type, [...(byType.get(entity.type) ?? []), keys.get(entity.key) ?? 'none']);
  return [...byType].filter(([, cites]) => cites.length >= 2).map(([type, cites]) => ({ type, cites }));
}

async function removedOf(view: LabelledCase, text: string, cites: (keys: ReadonlyMap<string, string>) => string[]): Promise<boolean> {
  const probe = startRig({ replies: [replyOf()], settings: { maxCalls: 1 } });
  await probe.summarize(readingOf(view));
  const keys = keyMapOf(view, probe.requests[0]?.values ?? '');
  const rig = startRig({ replies: [replyOf({ text, cites: cites(keys) })], settings: { maxCalls: 1 } });
  await rig.summarize(readingOf(view));
  return (rig.store.runs[0]?.removals.length ?? 0) > 0;
}

describe('a sentence that says all of a type, over every labelled view of both packs and the AML views', () => {
  const groups = set.cases.flatMap((view) => {
    const probeKeys = new Map(view.entities.map((entity, index) => [entity.key, `n${index + 1}`] as const));
    return groupsOf(view, probeKeys).map((group) => [`${view.pack}/${view.id}/${group.type}`, view, group.type] as const);
  });

  it('covers both packs and the AML views', () => {
    expect(new Set(set.cases.filter((view) => groups.some(([, held]) => held.id === view.id)).map((view) => view.pack))).toEqual(new Set(['banking-fraud', 'insurance-claims']));
    expect(groups.length).toBeGreaterThanOrEqual(10);
  });

  it.each(groups)('keeps it with every element of %s cited, and removes it with one left out', async (_name, view, type) => {
    const members = (keys: ReadonlyMap<string, string>): string[] => view.entities.filter((entity) => entity.type === type).map((entity) => keys.get(entity.key) ?? 'none');
    const text = `All the ${type.toLowerCase()}s are listed.`;
    expect(await removedOf(view, text, members)).toBe(false);
    expect(await removedOf(view, text, (keys) => members(keys).slice(1))).toBe(true);
  });
});

describe('claims of absence over a view with no relationship', () => {
  const view = reading([node('widget', 'W-1', 'Item A'), node('widget', 'W-2', 'Item B')]);

  async function kept(text: string, cites: string[], mutation?: Mutation): Promise<boolean> {
    vi.resetModules();
    if (mutation !== undefined) vi.doMock('../../../ee/ask/src/case-summary/checks.js', async () => mutatedChecks(mutation));
    const { createCaseSummarizer } = await import('../../../ee/ask/src/case-summary/summarizer.js');
    const rig = startRig({ replies: [replyOf({ text, cites })], settings: { maxCalls: 1 }, factory: createCaseSummarizer });
    await rig.summarize(view);
    return (rig.store.runs[0]?.removals.length ?? 0) === 0;
  }

  it('removes a sentence that says no relationship is in view when it cites only an element', async () => {
    expect(await kept('No relationship lines are in view.', ['n1'])).toBe(false);
  });

  it('keeps it, as the product built it, when the check of the claims is taken out: the canary that the removal depends on the check', async () => {
    expect(await kept('No relationship lines are in view.', ['n1'], NO_BACKING_OF_CLAIMS)).toBe(true);
  });
});
