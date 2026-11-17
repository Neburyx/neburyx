import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { PatternWithin } from '@neburyx/contracts';
import { builderProfile } from './builder-kit.js';
import { breakText } from './copy.js';
import { draftWords } from './draft-words.js';
import { ExtensionCard } from './extension-card.js';
import { breaksOf, type Draft } from './model.js';

afterEach(cleanup);

const base = builderProfile();
const timed = { ...base, relationshipTypes: base.relationshipTypes.map((row) => ({ ...row, observedAt: 'when' })) };
const draftOf = (within: PatternWithin): Draft => ({
  anchorType: 'n-a',
  steps: [
    { direction: 'out', arrivesAt: 'n-b', relationshipTypes: ['r-1'] },
    { direction: 'out', arrivesAt: 'n-c', relationshipTypes: ['r-3'], after: 'previous', within },
  ],
});
const nameOf = (type: string | undefined): string => type ?? '';

describe('the step card of an order with a delay, as the frames draw it', () => {
  it('is titled "after the previous step, with a limit" and says the delay on its own row', () => {
    render(<ExtensionCard profile={timed} draft={draftOf({ hours: 24 })} index={1} nameOf={nameOf} wrong={false} />);
    expect(screen.getByText('Step 2 · after the previous step, with a limit')).toBeTruthy();
    expect(screen.getByText('Within').nextElementSibling?.textContent).toBe('24 hours');
    expect(screen.getByText('Ordered by').nextElementSibling?.textContent).toBe('when (date)');
    expect(screen.getByText('Shown here, not editable yet. It can be run and kept as it is.')).toBeTruthy();
  });

  it('is titled "time limit" when it is kept and marked, with no time in the mapping and the delay unchecked', () => {
    render(<ExtensionCard profile={base} draft={draftOf({ hours: 24 })} index={1} nameOf={nameOf} wrong />);
    expect(screen.getByText('Step 2 · time limit')).toBeTruthy();
    expect(screen.getByText('Ordered by').nextElementSibling?.textContent).toBe('none in the mapping');
    expect(screen.getByText('Within').nextElementSibling?.textContent).toBe('24 hours (unchecked)');
    expect(screen.getByText('Not valid')).toBeTruthy();
  });

  it('says in the banner that the delay needs a time to measure from, and in the words, shorter, that it needs a time', () => {
    const draft = draftOf({ hours: 24 });
    const found = breaksOf(base, draft, false);
    const noTime = found.find((entry) => entry.kind === 'no-time');
    expect(noTime).toBeDefined();
    if (noTime === undefined) return;
    expect(breakText(noTime, nameOf)).toBe('Step 2: “within 24 hours” needs a time to measure from. r-3 and r-1 have none in the mapping.');
    const lines = draftWords(base, draft, nameOf, found, []);
    expect(lines[2]?.bad).toBe('Kept, not valid: “within” needs a time, and r-3 and r-1 have none in the mapping.');
    const order = breakText({ kind: 'no-time', step: 1, part: 'link', types: ['r-3'] }, nameOf);
    expect(order).toBe('Step 2: “after the previous step” needs a time in the mapping. r-3 has none.');
  });
});
