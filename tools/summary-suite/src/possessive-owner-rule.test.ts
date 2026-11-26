import type { GraphNode, SummaryReading } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { judgeSentences, type CheckedText } from '../../../ee/ai-runtime/src/reply-checks.js';
import { assembleText } from '../../../ee/ask/src/case-summary/assemble.js';
import { checkedTextOf } from '../../../ee/ask/src/case-summary/judge.js';
import { mutatedChecks, type Mutation } from './mutants.js';
import { edge, node, reading } from './view.js';

type Judge = (sentences: readonly { text: string; cites: readonly string[] }[], text: CheckedText) => { readonly kept: readonly unknown[] };

const NO_RULE: Mutation = { name: 'the rule of a possessive name', from: ' && possessivesAreLinked(sentence, assembled);', to: ';' };

describe.each([
  { pack: 'banking-fraud', holder: 'account', owner: 'customer', owns: 'HOLDS_ACCOUNT', paid: 'TRANSFERRED_TO' },
  { pack: 'insurance-claims', holder: 'policy', owner: 'claimant', owns: 'HOLDS_POLICY', paid: 'REFERRED_TO' },
])('a false owner said with a possessive is removed ($pack)', ({ holder, owner, owns, paid }) => {
  const nodes: GraphNode[] = [node(owner, 'G', 'Gamma Partners'), node(owner, 'D', 'Delta Traders'), node(holder, 'A', 'Holder A'), node(holder, 'B', 'Holder B')];
  const ref = (entityType: string, stableId: string): GraphNode['ref'] => ({ sourceId: 'demo', entityType, stableId });
  const view: SummaryReading = reading(nodes, [edge(paid, 'p', ref(holder, 'A'), ref(holder, 'B')), edge(owns, 'g', ref(owner, 'G'), ref(holder, 'B'))]);
  const assembled = assembleText(view);
  const text = checkedTextOf(assembled);
  const keyOf = (type: string): string => [...(text.elementTypes ?? [])].find(([, held]) => held === `relationship ${type}`)?.[0] ?? '';
  const holders = holder.endsWith('y') ? `${holder.slice(0, -1)}ies` : `${holder}s`;
  const holderKeys = [...(text.elementTypes ?? [])].filter(([, held]) => held === `entity ${holder}`).map(([key]) => key);
  const said = (name: string) => ({ text: `${name}' ${holders} are listed with Holder B.`, cites: [...holderKeys, keyOf(paid), keyOf(owns)] });
  const kept = (name: string): boolean => judgeSentences([said(name)], text).kept.length === 1;

  it('keeps the owner the cited link joins, and removes another named in its place, which the rule alone catches', async () => {
    expect(kept('Gamma Partners')).toBe(true);
    expect(kept('Delta Traders')).toBe(false);
    const judge = (await mutatedChecks(NO_RULE))['judgeSentences'] as Judge;
    expect(judge([said('Delta Traders')], text).kept).toHaveLength(1);
  });
});
