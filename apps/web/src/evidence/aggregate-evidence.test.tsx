import { act, cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { aggregateEdge } from '../inspector/relationship-kit.js';
import { select } from '../inspector/inspector-kit.js';
import { edgeKey } from '../state/keys.js';
import { aggregateDetailOf, answerEdge, derivedDetailOf, evidenceRig, failEdge, inPanel, openOn, OWNS, panel, selectEdge, SHARED, SUMMED } from './evidence-kit.js';
import { membersScopeLine, sampleHeading } from './copy.js';

afterEach(cleanup);
const rigWith = () => evidenceRig({}, [OWNS, SUMMED, SHARED]);

describe('the sentences of an aggregate in the panel', () => {
  it('names the order of the sample that was used, and says "most recent" only for the observed-time order', () => {
    expect(sampleHeading('observed-newest', 25)).toBe('Sample · first 25 by most recent observed time');
    expect(sampleHeading('source-order', 25)).toBe("Sample · 25 members, in the source's order");
    expect(sampleHeading('source-order', 1)).toBe("Sample · 1 member, in the source's order");
    expect(sampleHeading('source-order', 25)).not.toMatch(/recent/i);
    expect(membersScopeLine('PAID')).toBe("Counts every PAID relationship between these two, whatever the view's filters.");
  });
});

describe('the aggregate relationship in the panel', () => {
  it('shows the sentence, the exact count with what it covers, the observed range and the sample with the rest as a count and no paging', async () => {
    const rig = rigWith();
    openOn(rig, SUMMED);
    expect(inPanel().getByRole('status').textContent).toBe('Reading the evidence…');
    await answerEdge(rig.edgeReads[0], aggregateDetailOf());
    expect(inPanel().getByText('Aggregate relationship')).toBeTruthy();
    expect(inPanel().getByText('Why is this relationship here?')).toBeTruthy();
    expect(inPanel().getByText('The source has no stable ID for this relationship type.')).toBeTruthy();
    expect(inPanel().getByText('Members 42 · exact')).toBeTruthy();
    expect(inPanel().getByText("Counts every PAID relationship between these two, whatever the view's filters.")).toBeTruthy();
    expect(inPanel().getByText(/First observed/).textContent).toContain('2026');
    expect(inPanel().getByText(/Last observed/).textContent).toContain('UTC');
    expect(inPanel().getByText('Sample · first 3 by most recent observed time')).toBeTruthy();
    expect(inPanel().getAllByRole('listitem')).toHaveLength(3);
    expect(inPanel().getByText('… 39 more in this sample. There is no paging.')).toBeTruthy();
    expect(inPanel().queryByRole('link')).toBeNull();
    expect(inPanel().getAllByRole('button').map((button) => button.getAttribute('aria-label') ?? button.textContent)).not.toContain('Next');
    rig.unbind();
  });

  it('gives a sample row its time and properties and no identifier, link, copy button or menu', async () => {
    const rig = rigWith();
    openOn(rig, SUMMED);
    await answerEdge(rig.edgeReads[0], aggregateDetailOf());
    const [row] = inPanel().getAllByRole('listitem');
    expect(row?.textContent).toContain('remark web');
    expect(row?.querySelector('a, button, [role="button"], [aria-haspopup]')).toBeNull();
    expect(panel()?.textContent).not.toMatch(/elementId|REL-/);
    rig.unbind();
  });

  it('names that the source ordered the sample and shows no "more" line when the sample holds every member', async () => {
    const rig = rigWith();
    openOn(rig, SUMMED);
    const detail = aggregateDetailOf();
    await answerEdge(rig.edgeReads[0], aggregateDetailOf({ members: { value: 3, quality: 'exact', scope: 'aggregate:members' }, sample: { order: 'source-order', rows: detail.sample.rows, more: 0 } }));
    expect(inPanel().getByText("Sample · 3 members, in the source's order")).toBeTruthy();
    expect(inPanel().queryByText(/more in this sample/)).toBeNull();
    expect(inPanel().queryByText(/recent/i)).toBeNull();
    rig.unbind();
  });

  it('says that the relationships have no usable stable ID for an aggregate of a type that has one', async () => {
    const rig = rigWith();
    openOn(rig, SUMMED);
    await answerEdge(rig.edgeReads[0], aggregateDetailOf({ qualityFlags: ['no-stable-id'] }));
    expect(inPanel().getByText('These PAID relationships have no usable stable ID in the source.')).toBeTruthy();
    expect(inPanel().queryByText('The source has no stable ID for this relationship type.')).toBeNull();
    rig.unbind();
  });

  it('shows "not counted" with the reason, and still the sample, for an unknown count, with no range and no more line', async () => {
    const rig = rigWith();
    openOn(rig, SUMMED);
    const warning = "The member count and observed range could not be read within the source's time limit.";
    const { observedFirst: _first, observedLast: _last, ...rest } = aggregateDetailOf();
    await answerEdge(rig.edgeReads[0], { ...rest, members: { quality: 'unknown', scope: 'aggregate:members' }, sample: { order: 'observed-newest', rows: aggregateDetailOf().sample.rows }, warnings: [warning] });
    expect(inPanel().getByText('Members · not counted')).toBeTruthy();
    expect(inPanel().getByText(warning)).toBeTruthy();
    expect(inPanel().queryByText(/First observed|Last observed|exact|more in this sample/)).toBeNull();
    expect(inPanel().getAllByRole('listitem').length).toBeGreaterThanOrEqual(3);
    await userEvent.click(screen.getByRole('tab', { name: 'Properties' }));
    expect(inPanel().getByText('Members · not counted')).toBeTruthy();
    rig.unbind();
  });

  it('lists the type, both ends, the count and the order on the Properties sub-tab', async () => {
    const rig = rigWith();
    openOn(rig, SUMMED);
    await answerEdge(rig.edgeReads[0], aggregateDetailOf());
    await userEvent.click(screen.getByRole('tab', { name: 'Properties' }));
    expect(inPanel().getByText('PAID')).toBeTruthy();
    expect(inPanel().getByText('Members 42 · exact')).toBeTruthy();
    expect(inPanel().getByText('Most recent observed time first')).toBeTruthy();
    rig.unbind();
  });

  it('shows a failed read as the stored kind does, and rereads on Try again', async () => {
    const rig = rigWith();
    openOn(rig, SUMMED);
    await failEdge(rig.edgeReads[0], 'QUERY_TIMEOUT', true);
    expect(inPanel().getByRole('alert')).toBeTruthy();
    await userEvent.click(inPanel().getByRole('button', { name: 'Try again' }));
    expect(rig.edgeReads).toHaveLength(2);
    rig.unbind();
  });

  it('is offered for an aggregate reference, which the menu and the panel follow', async () => {
    const rig = rigWith();
    expect(rig.evidence.offers(SUMMED.ref)).toBe(true);
    expect(rig.evidence.offers(OWNS.ref)).toBe(true);
    openOn(rig, OWNS);
    await answerEdge(rig.edgeReads[0], { ...aggregateDetailOf(), semantics: 'aggregate' });
    selectEdge(rig, SUMMED);
    await act(async () => undefined);
    expect(rig.edgeCalls.map((call) => call.id)).toContain('PAID');
    rig.unbind();
  });
});

describe('opening an aggregate from the supports of a derived relationship', () => {
  it('has an Evidence button on a support with no stable ID that opens the aggregate\'s panel', async () => {
    const rig = rigWith();
    openOn(rig, SHARED);
    await answerEdge(rig.edgeReads[0], derivedDetailOf());
    const button = inPanel().getByRole('button', { name: 'Evidence of SENT: Title m2 → Title n3' });
    await userEvent.click(button);
    expect(rig.edgeCalls.map((call) => call.id)).toContain('SENT');
    await answerEdge(rig.edgeReads[1], aggregateDetailOf({ type: 'SENT', ref: { sourceId: 'a', aggregate: { type: 'SENT', from: derivedDetailOf().supports.groups[1]?.middle[0]?.ref ?? derivedDetailOf().from.ref, to: derivedDetailOf().to.ref } } }));
    expect(inPanel().getByText('Aggregate relationship')).toBeTruthy();
    rig.unbind();
  });
});

describe('the count of an aggregate drawn by a filtered expansion', () => {
  it('shows the panel\'s own count of all members with the line that says so, beside the smaller count the canvas label holds', async () => {
    const rig = rigWith();
    expect(SUMMED.memberCount?.value).toBe(3);
    openOn(rig, SUMMED);
    await answerEdge(rig.edgeReads[0], aggregateDetailOf());
    expect(inPanel().getByText('Members 42 · exact')).toBeTruthy();
    expect(inPanel().getByText("Counts every PAID relationship between these two, whatever the view's filters.")).toBeTruthy();
    rig.unbind();
  });
});

describe('a sampled member with nothing to show', () => {
  it('says so instead of drawing an empty row', async () => {
    const rig = rigWith();
    openOn(rig, SUMMED);
    await answerEdge(rig.edgeReads[0], aggregateDetailOf({ members: { value: 1, quality: 'exact', scope: 'aggregate:members' }, sample: { order: 'source-order', rows: [{ properties: [] }], more: 0 } }));
    expect(inPanel().getByText('No observed time or mapped property to show')).toBeTruthy();
    rig.unbind();
  });
});

describe('reaching the evidence of an aggregate', () => {
  const PAID = aggregateEdge('n1', 'n3', { value: 3, quality: 'exact', scope: 'x' }, 'PAID');

  it('lists an aggregate in the inspector\'s Evidence tab after the stored and before the derived ones, and opens its panel from the row', async () => {
    const rig = evidenceRig({}, [SHARED, PAID, OWNS]);
    select(rig.state, 'n1');
    await act(async () => screen.getByRole('tab', { name: 'Evidence' }).click());
    const rows = screen.getAllByRole('button').filter((button) => button.classList.contains('relationship-row')).map((button) => button.getAttribute('aria-label'));
    expect(rows).toEqual(['OWNS, Title n2 · Kind A', 'PAID, Title n3 · Kind A', 'SHARED, Title n3 · Kind A']);
    await act(async () => screen.getByRole('button', { name: 'PAID, Title n3 · Kind A' }).click());
    expect(panel()).not.toBeNull();
    expect(rig.edgeCalls.map((call) => call.id)).toEqual(['PAID']);
    rig.unbind();
  });

  it('offers both menu items for an aggregate and opens the panel on it with Enter', async () => {
    const rig = evidenceRig({}, [OWNS, PAID]);
    act(() => rig.state.presentation.setOpenMenu({ kind: 'relationship', key: edgeKey(PAID.ref), x: 40, y: 40 }));
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Why is this relationship here?↵', 'View supporting records']);
    await act(async () => undefined);
    await userEvent.keyboard('{Enter}');
    expect(panel()).not.toBeNull();
    expect(rig.edgeCalls.map((call) => call.id)).toEqual(['PAID']);
    rig.unbind();
  });

  it('returns focus, on Esc from the aggregate\'s panel, to the control that opened the derived panel first', async () => {
    const rig = rigWith();
    const opener = document.body.appendChild(document.createElement('button'));
    opener.textContent = 'Open';
    opener.focus();
    act(() => void rig.evidence.open(SHARED.ref, opener));
    await answerEdge(rig.edgeReads[0], derivedDetailOf());
    await userEvent.click(inPanel().getByRole('button', { name: 'Evidence of SENT: Title m2 → Title n3' }));
    await answerEdge(rig.edgeReads[1], aggregateDetailOf({ type: 'SENT' }));
    expect(inPanel().getByText('Aggregate relationship')).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(opener);
    opener.remove();
    rig.unbind();
  });
});
