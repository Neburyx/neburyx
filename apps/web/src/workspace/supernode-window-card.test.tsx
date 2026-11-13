import { cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { answerExpand, answerPreview, count, inPanel, panelRig, previewOf, response } from './supernode-kit.js';

afterEach(() => cleanup());

const card = () => within(inPanel().getByRole('region', { name: 'Node' }));
const RANGE = { from: '2026-11-05T00:00:00.000Z', to: '2026-11-13T00:00:00.000Z' };
const windowed = (hasMore: boolean, over: { matching?: ReturnType<typeof count>; applied?: 'full' | 'partial' | 'none'; notAppliedTo?: string[]; undatedLeftOut?: number } = {}) =>
  response({
    window: RANGE,
    pages: [
      {
        neighborType: 'kind-b',
        returned: 1,
        hasMore,
        ...(hasMore ? { nextCursor: 'v1.one.mac' } : {}),
        matchingTotal: over.matching ?? { value: 41, quality: 'exact', scope: 'expand:window' },
        window: { applied: over.applied ?? 'full', notAppliedTo: over.notAppliedTo ?? [], ...(over.undatedLeftOut === undefined ? {} : { undatedLeftOut: over.undatedLeftOut }) },
      },
    ],
  });
const previewOfFifteen = () => previewOf({ total: count(15, 'exact'), byNeighborType: [{ entityType: 'kind-b', count: count(15, 'exact') }] });

async function loaded(reply: ReturnType<typeof windowed>) {
  const rig = panelRig();
  await rig.open();
  await answerPreview(rig.previews[0], previewOfFifteen());
  await userEvent.setup().click(inPanel().getByRole('button', { name: 'Load 25 per type' }));
  await answerExpand(rig.expansions[0], reply);
  return rig;
}

describe('the counts and notes of a windowed chain in the node card', () => {
  it('says the count for the window beside the all-time degree, labels what is not loaded as all time and offers more while the pages go on', async () => {
    await loaded(windowed(true));
    expect(card().getByText('In the last 7 days: 41 · exact')).not.toBeNull();
    expect(card().getByText('15 · exact')).not.toBeNull();
    expect(card().getByText(/not loaded.*all time/)).not.toBeNull();
    expect(card().getByRole('button', { name: /^Load 25 more:/ })).not.toBeNull();
    expect(card().queryByText(/Everything in the last/)).toBeNull();
  });

  it('says everything in the window is loaded when the chain ended, offers no load action and not the note that all sourced types were exhausted, and points to the window', async () => {
    await loaded(windowed(false));
    expect(card().getByText('Everything in the last 7 days is loaded. Choose a longer window or All time for more.')).not.toBeNull();
    expect(card().queryByRole('button', { name: /^Load/ })).toBeNull();
    expect(card().queryByText(/could not be shown are left out/)).toBeNull();
    expect(card().queryByText(/over all sourced types/)).toBeNull();
    expect(inPanel().getByRole('combobox', { name: /Time window/ })).not.toBeNull();
  });

  it('names the relationship types the window did not apply to and says how the count reads for a partly windowed page', async () => {
    await loaded(windowed(true, { applied: 'partial', notAppliedTo: ['link-z'], undatedLeftOut: 3 }));
    expect(card().getByText('In the last 7 days for dated relationships, all time for link-z: 41 · exact')).not.toBeNull();
    expect(card().getByText('Not filtered by date: link-z.')).not.toBeNull();
    expect(card().getByText('3 relationships with no date are not included.')).not.toBeNull();
  });

  it('says a count with no number could not be counted and shows no number for it', async () => {
    await loaded(windowed(true, { matching: { quality: 'unknown', scope: 'expand:window' } }));
    expect(card().getByText('The relationships in the window could not be counted.')).not.toBeNull();
    expect(card().queryByText(/In the last 7 days: /)).toBeNull();
  });

  it('shows nothing about a window for all time or for a window that applied to no type', async () => {
    await loaded(windowed(false, { applied: 'none', notAppliedTo: ['kind-b'], matching: { value: 3, quality: 'exact', scope: 'expand:page' } }));
    expect(card().queryByText(/In the last/)).toBeNull();
    expect(card().queryByText(/Everything in the last/)).toBeNull();
    expect(card().queryByText(/all time/)).toBeNull();
  });

  it('shows the count for the window in the panel beside the type, never beside the total of the entity', async () => {
    await loaded(windowed(true));
    expect(inPanel().getAllByText(/In the last 7 days: 41 · exact/).length).toBeGreaterThan(0);
    expect(inPanel().queryByText(/41 · exact of /)).toBeNull();
  });

  const empty = () =>
    response({
      window: RANGE,
      nodes: [],
      edges: [],
      pages: [{ neighborType: 'kind-b', returned: 0, hasMore: false, matchingTotal: { value: 0, quality: 'exact', scope: 'expand:window' }, window: { applied: 'full', notAppliedTo: [], undatedLeftOut: 0 } }],
    });

  it('says plainly that the window left nothing, with the window named and the all-time degree with its own quality, and claims no number outside the window', async () => {
    await loaded(empty());
    expect(card().getByText('No relationships in the last 7 days.')).not.toBeNull();
    expect(card().getByText('15 relationships in all time (exact).')).not.toBeNull();
    expect(inPanel().getByText('Kind-b: no relationships in the last 7 days.', { exact: false })).not.toBeNull();
    expect(card().queryByText(/Everything in the last/)).toBeNull();
    expect(inPanel().queryByText(/outside the window/i)).toBeNull();
  });

  it('widens to all time in one step, from the node card and from the panel, and loads the first page again without a window', async () => {
    const user = userEvent.setup();
    const rig = await loaded(empty());
    await user.click(card().getByRole('button', { name: /^Show all time/ }));
    expect(rig.expansions[1]?.body).not.toHaveProperty('window');
    expect(inPanel().getByRole('combobox', { name: /Time window/ })).toHaveProperty('value', 'all');
  });

  it('shows the panel button too', async () => {
    const user = userEvent.setup();
    const rig = await loaded(empty());
    const buttons = inPanel().getAllByRole('button', { name: /^Show all time/ });
    expect(buttons.length).toBe(2);
    await user.click(buttons[0] as HTMLElement);
    expect(rig.expansions[1]?.body).not.toHaveProperty('window');
  });

  it('says nothing of the all-time degree when the preview has no number', async () => {
    const rig = panelRig();
    await rig.open();
    await answerPreview(rig.previews[0], previewOf({ total: { quality: 'unknown', scope: 'x' }, byNeighborType: [{ entityType: 'kind-b', count: { quality: 'unknown', scope: 'x' } }] }));
    await userEvent.setup().click(inPanel().getByRole('button', { name: 'Load 25 per type' }));
    await answerExpand(rig.expansions[0], empty());
    expect(card().getByText('No relationships in the last 7 days.')).not.toBeNull();
    expect(card().queryByText(/in all time/)).toBeNull();
  });
});
