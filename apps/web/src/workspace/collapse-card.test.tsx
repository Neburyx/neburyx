import { act, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { COLLAPSE_LOADING, COLLAPSE_NOTHING } from './expand-copy.js';
import { answerExpand, answerPreview, count, inPanel, panelRig, previewOf, response } from './supernode-kit.js';

afterEach(() => cleanup());

const card = () => within(inPanel().getByRole('region', { name: 'Node' }));
const button = () => card().getByRole('button', { name: 'Collapse' });
const off = () => button().getAttribute('aria-disabled') === 'true';
const small = previewOf({ total: count(15, 'exact'), byNeighborType: [{ entityType: 'kind-b', count: count(15, 'exact') }] });
const page = [{ neighborType: 'kind-b', returned: 1, hasMore: true, nextCursor: 'v1.one.mac', matchingTotal: { quality: 'unknown' as const, scope: 'x' } }];

async function expanded() {
  const rig = panelRig();
  await rig.open();
  await answerPreview(rig.previews[0], small);
  const user = userEvent.setup();
  await user.click(inPanel().getByRole('button', { name: 'Load 25 per type' }));
  return { ...rig, user };
}

describe('Collapse on the node card', () => {
  it('is off with the reason before anything was loaded, linked to the button', async () => {
    const { open, previews } = panelRig();
    await open();
    await answerPreview(previews[0], small);
    expect(off()).toBe(true);
    const reason = button().getAttribute('aria-describedby');
    expect(card().getByText(COLLAPSE_NOTHING).id).toBe(reason);
  });

  it('is a plain button of the load links\' style, with no animation, and works from the keyboard', async () => {
    const { expansions, state, user } = await expanded();
    await answerExpand(expansions[0], response({ pages: page }));
    expect(off()).toBe(false);
    expect(button().tagName).toBe('BUTTON');
    expect(button().classList.contains('neighbor-types-link')).toBe(true);
    expect(button().getAttribute('style')).toBeNull();
    expect(state.loadedGraph().nodes.length).toBe(3);
    for (let press = 0; press < 40 && document.activeElement !== button(); press += 1) await user.tab();
    expect(document.activeElement).toBe(button());
    await user.keyboard('{Enter}');
    expect(state.loadedGraph().nodes.map((held) => held.ref.stableId)).toEqual(['n1', 'n2']);
    expect(inPanel().getByRole('region', { name: 'Node' })).toBeDefined();
    expect(card().getAllByText('0 loaded · 15 not loaded').length).toBeGreaterThan(0);
    expect(off()).toBe(true);
    expect(expansions).toHaveLength(1);
  });

  it('is off, with its reason, while the node is loading, and on again after the request ends', async () => {
    const { expansions } = await expanded();
    expect(off()).toBe(true);
    expect(card().getByText(COLLAPSE_LOADING).id).toBe(button().getAttribute('aria-describedby'));
    await answerExpand(expansions[0], response({ pages: page }));
    expect(off()).toBe(false);
  });

  it('does nothing when pressed while off', async () => {
    const { user, state, expansions } = await expanded();
    await user.click(button());
    expect(state.loadedGraph().nodes).toHaveLength(2);
    await act(async () => undefined);
    expect(expansions).toHaveLength(1);
  });

  it('takes the node back with Space as well', async () => {
    const { expansions, state, user } = await expanded();
    await answerExpand(expansions[0], response({ pages: page }));
    for (let press = 0; press < 40 && document.activeElement !== button(); press += 1) await user.tab();
    await user.keyboard(' ');
    expect(state.loadedGraph().nodes).toHaveLength(2);
  });
});
