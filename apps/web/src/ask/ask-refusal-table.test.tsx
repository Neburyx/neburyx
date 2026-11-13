import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ASK_REFUSAL_FAMILIES, type AskRefusalFamily } from '@neburyx/contracts';
import { answerAsk, drawAsk, field, previewOf } from './ask-kit.js';
import { REFUSAL_LINES } from './copy.js';
import { CHIP_LABELS, chipsOf } from './refusal-chips.js';

afterEach(cleanup);

/** What the card of each family shows beside the server's sentence: the line and the names of its chips. */
const EXPECTED: Readonly<Record<AskRefusalFamily, { readonly line: string; readonly chips: readonly string[] }>> = {
  path: { line: 'Expand each entity and follow its relationships.', chips: ['Expand'] },
  'property-selection': { line: 'Filters narrows the loaded items by type, not by a value. Search also matches the values of indexed properties.', chips: ['Open Filters', 'Search'] },
  'similar-records': { line: 'Expand an entity and compare the entities around it.', chips: ['Expand'] },
  'ranking-or-aggregate': { line: 'There is no alternative for this in this release.', chips: [] },
  'attribute-combination': { line: 'Expand an entity and look at its properties and its neighbours side by side.', chips: ['Expand'] },
  'indirect-attribute': { line: 'Expand the entity and open the one it is linked to.', chips: ['Expand'] },
  'unnamed-relation': { line: 'Expand an entity and look at the relationships it has.', chips: ['Expand'] },
  judgement: { line: 'Look at what connects the entities and at the evidence of each relationship.', chips: ['Expand'] },
  'personal-data': { line: 'If you have a stable ID, search for it.', chips: ['Search by stable ID'] },
  'loaded-view': { line: 'There is no alternative for this in this release.', chips: [] },
  other: { line: 'Search by stable ID, narrow with Filters, or expand an entity.', chips: ['Search by stable ID', 'Open Filters', 'Expand'] },
  'plan-not-usable': { line: 'Search by stable ID, narrow with Filters, or expand an entity.', chips: ['Search by stable ID', 'Open Filters', 'Expand'] },
  'model-refused': { line: 'Search by stable ID, narrow with Filters, or expand an entity.', chips: ['Search by stable ID', 'Open Filters', 'Expand'] },
};

describe('the table of refusal families, in the panel', () => {
  it('has a row for every family of the list and none besides, which a new family fails until it has one', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...ASK_REFUSAL_FAMILIES].sort());
    expect(Object.keys(REFUSAL_LINES).sort()).toEqual([...ASK_REFUSAL_FAMILIES].sort());
  });

  it.each(ASK_REFUSAL_FAMILIES)('draws the card of %s with its line and its chips', async (family) => {
    const harness = drawAsk();
    await userEvent.type(field(), 'which widgets');
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await answerAsk(harness.asks[0], previewOf('which widgets'));
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await answerAsk(harness.asks[1], { ok: true, value: { plan: { kind: 'unsupported', family, reason: 'Fixed words of the server.' } } });
    const card = screen.getByRole('region', { name: 'This question was not answered' });
    expect(card.textContent).toContain('Fixed words of the server.');
    expect(card.textContent).toContain(EXPECTED[family].line);
    expect(Array.from(card.querySelectorAll('button')).map((button) => button.textContent)).toEqual(EXPECTED[family].chips);
    expect(chipsOf(family, false).map((chip) => CHIP_LABELS[chip])).toEqual(EXPECTED[family].chips);
  });
});
