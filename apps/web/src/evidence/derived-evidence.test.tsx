import { act, cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { answerEdge, derivedDetailOf, evidenceRig, failEdge, inPanel, openOn, OWNS, panel, selectEdge, SHARED, SUMMED } from './evidence-kit.js';
import { derivationSentence, groupsCountText } from './copy.js';

afterEach(cleanup);
const rigWith = () => evidenceRig({}, [OWNS, SHARED, SUMMED]);

describe('the sentence that explains a derivation', () => {
  it('says "the shared" type for one middle entity and lists the types in chain order, without "shared", for more', () => {
    expect(derivationSentence('r', 2, 'A', 'B', ['Gizmo'])).toBe('Derived by rule r (version 2). A and B are linked through the shared Gizmo shown below.');
    expect(derivationSentence('r', 1, 'A', 'B', ['Widget', 'Widget'])).toBe('Derived by rule r (version 1). A and B are linked through the Widget and Widget shown below.');
    expect(derivationSentence('r', 1, 'A', 'B', ['Widget', 'Card', 'Widget'])).not.toContain('shared');
  });

  it('writes the count of groups with its quality', () => {
    expect(groupsCountText(1, 'exact')).toBe('1 group · exact');
    expect(groupsCountText(3, 'exact')).toBe('3 groups · exact');
    expect(groupsCountText(25, 'lowerBound')).toBe('≥ 25 groups · lower bound');
  });
});

describe('the derived relationship in the panel', () => {
  it('shows the rule and its version, the sentence, the supports grouped by middle entity with records and states, the count with its quality and the line No confidence score', async () => {
    const rig = rigWith();
    openOn(rig, SHARED);
    expect(inPanel().getByRole('status').textContent).toBe('Reading the evidence…');
    await answerEdge(rig.edgeReads[0], derivedDetailOf());
    expect(inPanel().getByText('Derived relationship')).toBeTruthy();
    expect(inPanel().getByText('Why is this relationship here?')).toBeTruthy();
    expect(inPanel().getByText('Derived by rule rule-1 (version 2). Title n1 and Title n3 are linked through the shared Kind A shown below.')).toBeTruthy();
    expect(inPanel().getByText('2 groups · exact')).toBeTruthy();
    expect(inPanel().getByText('Title m1 · Kind A')).toBeTruthy();
    expect(inPanel().getByText('AUTH-1, AUTH-2')).toBeTruthy();
    expect(inPanel().getByText('Evidence not available')).toBeTruthy();
    expect(inPanel().getByText('No stable ID in the source: its records are not listed')).toBeTruthy();
    expect(inPanel().getByText('No confidence score')).toBeTruthy();
    rig.unbind();
  });

  it('uses the sentence without "shared" for a chain with more than one middle entity, and heads a group with its middle entities in order', async () => {
    const rig = rigWith();
    openOn(rig, SHARED);
    const detail = derivedDetailOf();
    const [first] = detail.supports.groups;
    if (first === undefined) throw new Error('no group');
    const [head] = first.middle;
    if (head === undefined) throw new Error('no middle entity');
    const two = { ...first, middle: [...first.middle, { ...head, title: 'Title m9' }] };
    await answerEdge(rig.edgeReads[0], { ...detail, supports: { ...detail.supports, count: { value: 1, quality: 'exact', scope: 'x' }, groups: [two] } });
    expect(inPanel().getByText(/linked through the Kind A and Kind A shown below\./)).toBeTruthy();
    expect(inPanel().getByText('Title m1 · Kind A → Title m9 · Kind A')).toBeTruthy();
    rig.unbind();
  });

  it('says "≥ 25 groups · lower bound" for a capped read and never "exact"', async () => {
    const rig = rigWith();
    openOn(rig, SHARED);
    const detail = derivedDetailOf();
    const [group] = detail.supports.groups;
    if (group === undefined) throw new Error('no group');
    await answerEdge(rig.edgeReads[0], { ...detail, supports: { ...detail.supports, count: { value: 25, quality: 'lowerBound', scope: 'x' }, groups: Array.from({ length: 25 }, () => group) } });
    expect(inPanel().getAllByText('≥ 25 groups · lower bound').length).toBeGreaterThan(0);
    expect(inPanel().queryByText(/· exact/)).toBeNull();
    rig.unbind();
  });

  it('lists the rule, its version, both ends and the count on the Properties sub-tab', async () => {
    const rig = rigWith();
    openOn(rig, SHARED);
    await answerEdge(rig.edgeReads[0], derivedDetailOf());
    await act(async () => inPanel().getByRole('tab', { name: 'Properties' }).click());
    for (const text of ['rule-1', '2', 'Title n1 · Kind A', 'Title n3 · Kind A', '2 groups · exact']) expect(inPanel().getByText(text)).toBeTruthy();
    rig.unbind();
  });

  it('shows a refusal as a failure with no hint of why, offers no Try again for NOT_FOUND, and offers it for a busy source', async () => {
    const rig = rigWith();
    openOn(rig, SHARED);
    await failEdge(rig.edgeReads[0], 'NOT_FOUND');
    expect(inPanel().getByRole('alert').textContent).toContain('NOT_FOUND');
    expect(inPanel().queryByRole('button', { name: 'Try again' })).toBeNull();
    rig.unbind();
    const busy = rigWith();
    openOn(busy, SHARED);
    await failEdge(busy.edgeReads[0], 'SOURCE_BUSY', true);
    expect(inPanel().getByRole('button', { name: 'Try again' })).toBeTruthy();
    busy.unbind();
  });

  it('never shows the answer for one relationship under another: moving the selection to a stored relationship cancels the derived read and shows the stored one', async () => {
    const rig = rigWith();
    openOn(rig, SHARED);
    expect(rig.edgeCalls).toHaveLength(1);
    selectEdge(rig, OWNS);
    await act(async () => undefined);
    expect(rig.edgeCalls).toHaveLength(2);
    expect(rig.edgeCalls[0]?.signal?.aborted).toBe(true);
    rig.unbind();
  });

  it('closes with Escape and gives focus back to the control that opened it', async () => {
    const rig = rigWith();
    const opener = document.createElement('button');
    document.body.append(opener);
    act(() => void rig.evidence.open(SHARED.ref, opener));
    await answerEdge(rig.edgeReads[0], derivedDetailOf());
    const user = userEvent.setup();
    await user.keyboard('{Escape}');
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(opener);
    opener.remove();
    rig.unbind();
  });

  it('is not offered for an aggregate relationship, which no kind builds yet', () => {
    const rig = rigWith();
    expect(rig.evidence.offers(SUMMED.ref)).toBe(false);
    expect(rig.evidence.offers(SHARED.ref)).toBe(true);
    screen.queryByRole('complementary');
    rig.unbind();
  });
});
