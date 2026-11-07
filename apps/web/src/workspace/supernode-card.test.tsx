import { act, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { answerExpand, answerPreview, count, failExpand, inPanel, panelRig, previewOf, response } from './supernode-kit.js';

afterEach(() => cleanup());

const card = () => within(inPanel().getByRole('region', { name: 'Node' }));
const page = (more: boolean, cursor = 'v1.one.mac') => [{ neighborType: 'kind-b', returned: 1, hasMore: more, ...(more ? { nextCursor: cursor } : {}), matchingTotal: { quality: 'unknown' as const, scope: 'x' } }];

describe('the node card', () => {
  it('shows no total before there is a preview, and the loaded counts', async () => {
    const { open, previews } = panelRig();
    await open();
    expect(card().getByText('total: no count')).not.toBeNull();
    expect(card().getAllByText('0 loaded · not loaded: no count').length).toBeGreaterThan(0);
    await act(async () => previews[0]?.answer({ ok: false, failure: { code: 'SOURCE_UNAVAILABLE', message: 'x', retryable: true, traceId: 't' } } as never));
    expect(card().getByText('total: no count')).not.toBeNull();
  });

  it('says SUPERNODE, the total exactly as the server gave it, the loaded and the not loaded counts, and each type with its numbers', async () => {
    const { open, previews } = panelRig();
    await open();
    await answerPreview(previews[0]);
    expect(card().getByText('TYPE-A · SUPERNODE')).not.toBeNull();
    expect(card().getByText('Total degree ≥ 3,316 · lower bound')).not.toBeNull();
    expect(card().getByText('0 loaded · ≥ 3,316 not loaded (lower bound)')).not.toBeNull();
    expect(card().getByText('kind-b')).not.toBeNull();
    expect(card().getByText('15 · exact')).not.toBeNull();
    expect(card().getByText('0 loaded · 15 not loaded')).not.toBeNull();
    expect(card().getByText('≥ 3,300 · lower bound')).not.toBeNull();
  });

  it('does not say SUPERNODE when every type fits one page, and has no Collapse button', async () => {
    const { open, previews } = panelRig();
    await open();
    await answerPreview(previews[0], previewOf({ total: count(15, 'exact'), byNeighborType: [{ entityType: 'kind-b', count: count(15, 'exact') }] }));
    expect(card().getByText('TYPE-A')).not.toBeNull();
    expect(card().queryByText(/SUPERNODE/)).toBeNull();
    expect(card().queryByRole('button', { name: /collapse/i })).toBeNull();
  });

  it('follows what is loaded, and loads the next page of a type with the cursor it was given until its pages end', async () => {
    const { open, previews, expansions } = panelRig();
    await open();
    await answerPreview(previews[0], previewOf({ total: count(15, 'exact'), byNeighborType: [{ entityType: 'kind-b', count: count(15, 'exact') }] }));
    const user = userEvent.setup();
    await user.click(inPanel().getByRole('button', { name: 'Load 25 per type' }));
    await answerExpand(expansions[0], response({ pages: page(true) }));
    expect(card().getAllByText('1 loaded · 14 not loaded')).toHaveLength(2);
    await user.click(card().getByRole('button', { name: /^Load 25 more:/ }));
    expect(expansions[1]?.body.cursors).toEqual({ 'kind-b': 'v1.one.mac' });
    await answerExpand(expansions[1], response({ nodes: [], edges: [], pages: page(false) }));
    expect(card().queryByRole('button', { name: /^Load/ })).toBeNull();
  });

  it('disables Load more while a load runs, keeps its numbers on a failure, and offers Start over after a refused cursor', async () => {
    const { open, previews, expansions } = panelRig();
    await open();
    await answerPreview(previews[0], previewOf({ total: count(15, 'exact'), byNeighborType: [{ entityType: 'kind-b', count: count(15, 'exact') }] }));
    const user = userEvent.setup();
    await user.click(inPanel().getByRole('button', { name: 'Load 25 per type' }));
    await answerExpand(expansions[0], response({ pages: page(true) }));
    await user.click(card().getByRole('button', { name: /^Load 25 more:/ }));
    expect(card().getByRole('button', { name: /^Load 25 more:/ }).getAttribute('aria-disabled')).toBe('true');
    await user.click(card().getByRole('button', { name: /^Load 25 more:/ }));
    expect(expansions).toHaveLength(2);
    await failExpand(expansions[1], 'CURSOR_INVALIDATED');
    expect(card().getAllByText('1 loaded · 14 not loaded')).toHaveLength(2);
    expect(card().queryByRole('button', { name: /^Load 25 more:/ })).toBeNull();
    await user.click(card().getByRole('button', { name: /^Start over for this type:/ }));
    expect(expansions[2]?.body.cursors).toBeUndefined();
  });

  it('offers a load over all sourced types after a chain narrowed to one relationship type has ended, and not when an all-types chain has', async () => {
    const { open, previews, expansions } = panelRig();
    await open();
    await answerPreview(previews[0], previewOf({ total: count(15, 'exact'), byNeighborType: [{ entityType: 'kind-b', count: count(15, 'exact') }] }));
    const user = userEvent.setup();
    await user.selectOptions(inPanel().getByRole('combobox', { name: 'Relationship type' }), 'link-a');
    await user.click(inPanel().getByRole('button', { name: 'Load 25 per type' }));
    await answerExpand(expansions[0], response({ pages: page(false) }));
    await user.click(card().getByRole('button', { name: /^Load 25 more, over all sourced types:/ }));
    expect(expansions[1]?.body.relTypes).toBeUndefined();
    await answerExpand(expansions[1], response({ nodes: [], edges: [], pages: page(false) }));
    expect(card().queryByRole('button', { name: /^Load/ })).toBeNull();
  });

  it('keeps Load more while a lower-bound total has been reached and there are more pages, and says no number is left', async () => {
    const { open, previews, expansions } = panelRig();
    await open();
    await answerPreview(previews[0], previewOf({ total: count(1, 'lowerBound'), byNeighborType: [{ entityType: 'kind-b', count: count(1, 'lowerBound') }] }));
    await userEvent.setup().click(inPanel().getByRole('button', { name: 'Load 25 per type' }));
    await answerExpand(expansions[0], response({ pages: page(true) }));
    expect(card().getAllByText('1 loaded · not loaded: no count').length).toBeGreaterThan(0);
    expect(card().getByRole('button', { name: /^Load 25 more:/ })).not.toBeNull();
  });

  it('says why a remainder is left when the pages over all sourced types are exhausted', async () => {
    const { open, previews, expansions } = panelRig();
    await open();
    await answerPreview(previews[0], previewOf({ total: count(15, 'exact'), byNeighborType: [{ entityType: 'kind-b', count: count(15, 'exact') }] }));
    await userEvent.setup().click(inPanel().getByRole('button', { name: 'Load 25 per type' }));
    await answerExpand(expansions[0], response({ pages: page(false) }));
    expect(card().getByText(/may have changed between them\. Relationships the source returned that could not be shown are left out\./)).not.toBeNull();
  });
});
