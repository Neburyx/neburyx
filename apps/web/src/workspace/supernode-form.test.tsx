import { act, cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { degreePreviewSchema, expandResponseSchema } from '@neburyx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { busyHubPreview, hubPage, hubPreview } from './fixtures/hub-100k.js';
import { answerExpand, answerPreview, count, failExpand, inPanel, panelRig, previewOf, response } from './supernode-kit.js';

afterEach(() => cleanup());

const rows = () => inPanel().getAllByRole('checkbox').map((row) => row.textContent);
const button = (name: string | RegExp) => inPanel().getByRole('button', { name });
const sizeField = () => inPanel().getByRole('spinbutton', { name: 'Page size per type' });
const typeSelect = () => inPanel().getByRole('combobox', { name: 'Relationship type' });
const failure = (code: string) => ({ ok: false, failure: { code, message: 'x', retryable: true, traceId: 'tr-3' } }) as never;

describe('the panel while the preview is not there', () => {
  it('says it is loading, keeps the mapped neighbor types tickable, and loads with the page size and no preview', async () => {
    const { open, previews, expansions } = panelRig();
    await open();
    expect(inPanel().getByRole('status').textContent).toBe('Loading neighbors');
    expect(rows()).toEqual(['kind-b']);
    await userEvent.setup().click(button('Load 25 per type'));
    expect(expansions[0]?.body).toMatchObject({ neighborTypes: ['kind-b'], limit: 25 });
    expect(previews).toHaveLength(1);
  });

  it('shows the failure with its code and Retry when the preview fails, asks again on Retry, and still loads', async () => {
    const { open, previews, expansions } = panelRig();
    await open();
    await act(async () => previews[0]?.answer(failure('SOURCE_UNAVAILABLE')));
    expect(inPanel().getByRole('alert').textContent).toBe('The source did not answer. Try again shortly. · trace tr-3');
    expect(rows()).toEqual(['kind-b']);
    await userEvent.setup().click(button('Retry'));
    expect(previews).toHaveLength(2);
    await userEvent.setup().click(button('Load 25 per type'));
    expect(expansions).toHaveLength(1);
  });

  it('offers no Retry when the preview fails with an unavailable source that retrying cannot help, and asks no second preview', async () => {
    const { open, previews } = panelRig();
    await open();
    await act(async () => previews[0]?.answer({ ok: false, failure: { code: 'SOURCE_UNAVAILABLE', message: 'x', retryable: false, traceId: 'tr-4', details: { reason: 'index-failed' } } } as never));
    expect(inPanel().getByRole('alert').textContent).toBe('A needed index failed, so the read was not run. · trace tr-4');
    expect(inPanel().queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(previews).toHaveLength(1);
  });
});

describe('the neighbor types and the relationship type', () => {
  it('lists every neighbor type with its count and quality, those of the preview first, with Select all and Invert selection and a summary', async () => {
    const { open, previews } = panelRig();
    await open();
    await answerPreview(previews[0]);
    expect(rows()).toEqual(['kind-b15 · exact', 'type-c≥ 3,300 · lower bound', 'type-dno count']);
    expect(inPanel().getByText('kind-b, type-c, type-d (3 of 3)')).not.toBeNull();
    const user = userEvent.setup();
    await user.click(inPanel().getByRole('checkbox', { name: /^kind-b/ }));
    expect(inPanel().getByText('type-c, type-d (2 of 3)')).not.toBeNull();
    await user.click(button('Invert selection'));
    expect(inPanel().getByText('kind-b (1 of 3)')).not.toBeNull();
    await user.click(button('Select all'));
    expect(inPanel().getByText('kind-b, type-c, type-d (3 of 3)')).not.toBeNull();
  });

  it('names an estimated count with its tilde and an unknown one without a number', async () => {
    const { open, previews } = panelRig();
    await open();
    await answerPreview(previews[0], previewOf({ byNeighborType: [{ entityType: 'kind-b', count: count(40, 'estimated') }, { entityType: 'type-c', count: count(undefined, 'unknown') }] }));
    expect(rows()).toEqual(['kind-b~ 40 (estimated)', 'type-cno count']);
  });

  it('lists the relationship types first with one count for each direction, and narrows the neighbor types to those they join, with a number only where the preview gives one for the combination', async () => {
    const { open, previews } = panelRig();
    await open();
    await answerPreview(previews[0]);
    expect(Array.from(typeSelect().querySelectorAll('option')).map((option) => option.textContent)).toEqual(['All sourced types', 'link-a (out 12 · exact; in 3 · exact)']);
    await userEvent.setup().selectOptions(typeSelect(), 'link-a');
    expect(rows()).toEqual(['kind-bout 12 · exact; in 3 · exact']);
    expect(inPanel().getByText('Left out, because link-a does not join them: type-c, type-d.')).not.toBeNull();
  });

  it('shows "no count for this combination" when the row of the relationship type names several neighbor types', async () => {
    const { open, previews } = panelRig();
    await open();
    await answerPreview(previews[0], previewOf({ byType: [{ relationshipType: 'link-a', direction: 'out', count: count(12, 'exact'), neighborTypes: ['kind-b', 'type-c'] }] }));
    await userEvent.setup().selectOptions(typeSelect(), 'link-a');
    expect(rows()).toEqual(['kind-bno count for this combination']);
  });

  it('offers one Rank by, Most recent, and says that relationships with no observed time are not ordered by time', async () => {
    const { open } = panelRig();
    await open();
    const rank = inPanel().getByRole('combobox', { name: /Rank by/ });
    expect(Array.from(rank.querySelectorAll('option')).map((option) => option.textContent)).toEqual(['Most recent']);
    expect(inPanel().getByText('These relationships have no observed time, so they are not ordered by time.')).not.toBeNull();
  });
});

describe('the page size and the button', () => {
  it('follows the field in the button, and disables the button with a message for a value outside 1 to the ceiling', async () => {
    const { open, previews } = panelRig();
    await open();
    await answerPreview(previews[0], previewOf({ pageSize: 10 }));
    const user = userEvent.setup();
    expect((sizeField() as HTMLInputElement).value).toBe('10');
    expect(button('Load 10 per type')).toHaveProperty('disabled', false);
    await user.clear(sizeField());
    await user.type(sizeField(), '30');
    expect(button('Load 30 per type')).toHaveProperty('disabled', false);
    for (const bad of ['0', '51', '2.5', '']) {
      await user.clear(sizeField());
      if (bad !== '') await user.type(sizeField(), bad);
      expect(inPanel().getByRole('alert').textContent).toBe('Enter a whole number from 1 to 50.');
      expect(inPanel().getByRole('button', { name: /^Load .* per type$/ })).toHaveProperty('disabled', true);
    }
  });

  it('disables the button and says why when no type is ticked', async () => {
    const { open, previews, expansions } = panelRig();
    await open();
    await answerPreview(previews[0], previewOf({ byNeighborType: [{ entityType: 'kind-b', count: count(15, 'exact') }] }));
    const user = userEvent.setup();
    await user.click(inPanel().getByRole('checkbox', { name: /^kind-b/ }));
    expect(inPanel().getByText('Choose at least one neighbor type')).not.toBeNull();
    expect(button(/^Load .* per type$/)).toHaveProperty('disabled', true);
    expect(expansions).toHaveLength(0);
  });

  it('loads the ticked types with one request that carries the page size and the relationship type, is disabled while it runs, and merges the page', async () => {
    const { open, previews, expansions, state } = panelRig();
    await open();
    await answerPreview(previews[0]);
    const user = userEvent.setup();
    await user.selectOptions(typeSelect(), 'link-a');
    await user.clear(sizeField());
    await user.type(sizeField(), '7');
    await user.click(button('Load 7 per type'));
    expect(expansions).toHaveLength(1);
    expect(expansions[0]?.body).toMatchObject({ neighborTypes: ['kind-b'], relTypes: ['link-a'], limit: 7 });
    expect(button('Load 7 per type').getAttribute('aria-disabled')).toBe('true');
    await user.click(button('Load 7 per type'));
    expect(expansions).toHaveLength(1);
    await answerExpand(expansions[0]);
    expect(state.loadedGraph().edges).toHaveLength(1);
    expect(button('Load 7 per type').getAttribute('aria-disabled')).toBeNull();
  });

  it('asks the next page for a type whose chain has the same relationship types and more, and the first page when the relationship type changed', async () => {
    const { open, previews, expansions } = panelRig();
    await open();
    await answerPreview(previews[0]);
    const user = userEvent.setup();
    await user.click(button('Load 25 per type'));
    await answerExpand(expansions[0], response({ pages: [{ neighborType: 'kind-b', returned: 1, hasMore: true, nextCursor: 'v1.one.mac', matchingTotal: { quality: 'unknown', scope: 'x' } }] }));
    await user.click(button('Load 25 per type'));
    expect(expansions[1]?.body.cursors).toEqual({ 'kind-b': 'v1.one.mac' });
    await answerExpand(expansions[1], response({ nodes: [], edges: [], pages: [{ neighborType: 'kind-b', returned: 0, hasMore: true, nextCursor: 'v1.two.mac', matchingTotal: { quality: 'unknown', scope: 'x' } }] }));
    await user.selectOptions(typeSelect(), 'link-a');
    await user.click(button('Load 25 per type'));
    expect(expansions[2]?.body).toMatchObject({ relTypes: ['link-a'] });
    expect(expansions[2]?.body.cursors).toBeUndefined();
  });
});

describe('the failures of a load', () => {
  it('shows the failure with its code and Retry, adds nothing, and retries the same ask', async () => {
    const { open, previews, expansions, state } = panelRig();
    await open();
    await answerPreview(previews[0]);
    const user = userEvent.setup();
    await user.click(button('Load 25 per type'));
    await failExpand(expansions[0], 'SOURCE_BUSY');
    expect(within(inPanel().getByRole('alert').parentElement as HTMLElement).getByText('SOURCE_BUSY · trace tr-9')).not.toBeNull();
    expect(state.loadedGraph().edges).toHaveLength(0);
    await user.click(button('Retry'));
    expect(expansions).toHaveLength(2);
  });

  it('offers no Retry when the load fails with an unavailable source that retrying cannot help', async () => {
    const { open, previews, expansions } = panelRig();
    await open();
    await answerPreview(previews[0]);
    await userEvent.setup().click(button('Load 25 per type'));
    await failExpand(expansions[0], 'SOURCE_UNAVAILABLE', { reason: 'index-failed' });
    expect(inPanel().getByRole('alert')).not.toBeNull();
    expect(inPanel().queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('offers Start over for a type whose cursor was refused, and no Retry', async () => {
    const { open, previews, expansions } = panelRig();
    await open();
    await answerPreview(previews[0]);
    const user = userEvent.setup();
    await user.click(button('Load 25 per type'));
    await answerExpand(expansions[0], response({ pages: [{ neighborType: 'kind-b', returned: 1, hasMore: true, nextCursor: 'v1.one.mac', matchingTotal: { quality: 'unknown', scope: 'x' } }] }));
    await user.click(button('Load 25 per type'));
    await failExpand(expansions[1], 'CURSOR_INVALIDATED');
    expect(inPanel().queryByRole('button', { name: 'Retry' })).toBeNull();
    await user.click(button(/^Start over for this type:/));
    expect(expansions[2]?.body.cursors).toBeUndefined();
  });

  it('lowers the field to the maxPage the server names, says so, and loads at once with it', async () => {
    const { open, previews, expansions } = panelRig();
    await open();
    await answerPreview(previews[0]);
    const user = userEvent.setup();
    await user.clear(sizeField());
    await user.type(sizeField(), '40');
    await user.click(button('Load 40 per type'));
    await failExpand(expansions[0], 'QUERY_BUDGET_EXCEEDED', { maxPage: 30 });
    expect((sizeField() as HTMLInputElement).value).toBe('30');
    expect(inPanel().getByText('This source allows pages of at most 30; the page size is now 30.')).not.toBeNull();
    await user.click(button('Load 30 per type'));
    expect(expansions[1]?.body.limit).toBe(30);
  });
});

describe('the rest of the panel', () => {
  it('carries the footnote and the notes, and a time window that is the last 7 days until it is changed', async () => {
    const { open, previews } = panelRig();
    await open();
    await answerPreview(previews[0], previewOf({ warnings: [{ code: 'counts-capped', reason: 'Counts stop at 500' }] }));
    expect(inPanel().getByText('Soft limit · aggregates beyond · bounded pages only.')).not.toBeNull();
    expect(inPanel().getByText('Counts are of relationship ends.')).not.toBeNull();
    expect(inPanel().getByText('Counts stop at 500.')).not.toBeNull();
    expect(inPanel().getByRole('combobox', { name: /Time window/ })).toHaveProperty('value', '7');
    expect(inPanel().getByText(/Only relationships observed in this period are loaded|does not apply/)).not.toBeNull();
  });

  it('previews the 100,000-relationship hub with each count labelled and loads the chosen page size for the type', async () => {
    expect(degreePreviewSchema.parse(hubPreview)).toEqual(hubPreview);
    expect(expandResponseSchema.parse(hubPage(12)).edges).toHaveLength(12);
    const { open, previews, expansions, state } = panelRig({ ids: ['big', 'n2'] });
    await open('big');
    await answerPreview(previews[0], hubPreview);
    expect(rows()).toEqual(['leaf≥ 500 · lower bound', 'kind-b']);
    expect(inPanel().getByText('Counts stop at 500 for this node.')).not.toBeNull();
    const user = userEvent.setup();
    await user.click(inPanel().getByRole('checkbox', { name: /^kind-b/ }));
    await user.clear(sizeField());
    await user.type(sizeField(), '12');
    await user.click(button('Load 12 per type'));
    expect(expansions[0]?.body).toMatchObject({ ref: { stableId: 'big' }, neighborTypes: ['leaf'], limit: 12 });
    await answerExpand(expansions[0], hubPage(12));
    expect(state.loadedGraph().edges).toHaveLength(12);
  });

  it('shows the counts of a node with 184,533 relationships as the source gave them, exact, and the card says what is not loaded', async () => {
    expect(degreePreviewSchema.parse(busyHubPreview)).toEqual(busyHubPreview);
    const { open, previews } = panelRig({ ids: ['busy', 'n2'] });
    await open('busy');
    await answerPreview(previews[0], busyHubPreview);
    expect(rows().slice(0, 2)).toEqual(['leaf169,756 · exact', 'peer14,775 · exact']);
    expect(inPanel().getByText('Total degree 184,533 · exact')).not.toBeNull();
    expect(inPanel().getByText('TYPE-A · SUPERNODE')).not.toBeNull();
    expect(inPanel().getAllByText('0 loaded · 184,533 not loaded').length).toBeGreaterThan(0);
  });
});
