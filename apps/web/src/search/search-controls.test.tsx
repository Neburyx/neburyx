import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { SearchResult } from '@neburyx/contracts';
import type { ApiResult } from '../api/client.js';
import { renderApp } from '../test-utils.js';
import { answerOf, hit, relatedOf, searchAt, searchKit } from './search-test-kit.js';

const main = () => screen.getByRole('main');
const ok = (value: SearchResult): ApiResult<SearchResult> => ({ ok: true, value });
const down: ApiResult<never> = { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } };

describe('the buttons of the Search results page', () => {
  it('marks Search primary and each result row\'s Open in graph link-style', async () => {
    const kit = searchKit(['demo', 'other'], async () => ok(answerOf('demo', [hit('demo', 'AC-1'), hit('demo', 'AC-2')])));
    renderApp(searchAt('demo', 'AC'), kit.client);
    await screen.findByRole('heading', { level: 2, name: /Exact ID match/ });
    expect(within(main()).getByRole('button', { name: 'Search' }).className).toBe('primary');
    const opens = within(main()).getAllByRole('button', { name: /^Open in graph/ });
    expect(opens).toHaveLength(2);
    expect(opens.map((button) => button.className)).toEqual(['link', 'link']);
  });

  it('marks the Retry of a failed search link-style and works as before', async () => {
    let calls = 0;
    const kit = searchKit(['demo'], async () => (++calls === 1 ? down : ok(answerOf('demo', [hit('demo', 'AC-1')]))));
    renderApp(searchAt('demo', 'AC'), kit.client);
    const retry = await within(main()).findByRole('button', { name: 'Retry' });
    expect(retry.className).toBe('link');
    await userEvent.setup().click(retry);
    await screen.findByRole('heading', { level: 2, name: /Exact ID match/ });
    expect(calls).toBe(2);
  });

  it('marks the Open in graph of a related row and the Retry of a group whose read failed link-style, like the other search buttons', async () => {
    const answer = answerOf('demo', [], {
      counts: { exact: { quality: 'unknown', scope: 'search:exact' } },
      related: relatedOf([hit('demo', 'REF-1'), hit('demo', 'REF-2')]),
      failures: [{ group: 'exact', code: 'SOURCE_BUSY' }],
    });
    renderApp(searchAt('demo', 'AC'), searchKit(['demo'], async () => ok(answer)).client);
    await screen.findByRole('heading', { level: 2, name: /Related records/ });
    expect(within(main()).getAllByRole('button', { name: /^Open in graph/ }).map((button) => button.className)).toEqual(['link', 'link']);
    const retry = within(main()).getByRole('button', { name: 'Retry' });
    expect(retry.classList.contains('link')).toBe(true);
    expect(retry.classList.contains('search-retry')).toBe(true);
  });

  it('marks the Try again of a failed sources read and of a failed profile read secondary', async () => {
    const kit = searchKit(['demo'], async () => ok(answerOf('demo', [])));
    const noSources = renderApp(searchAt('demo', 'AC'), { ...kit.client, getSources: async () => down });
    expect((await screen.findByRole('button', { name: 'Try again' })).className).toBe('secondary');
    noSources.unmount();
    renderApp(searchAt('demo', 'AC'), { ...kit.client, getProfile: async () => down });
    expect((await screen.findByRole('button', { name: 'Try again' })).className).toBe('secondary');
  });

  it('keeps the tab order: the source selector, the search box, Search, then the first Open in graph', async () => {
    const kit = searchKit(['demo', 'other'], async () => ok(answerOf('demo', [hit('demo', 'AC-1')])));
    renderApp(searchAt('demo', 'AC'), kit.client);
    const selector = await screen.findByRole('combobox', { name: 'Source' });
    await screen.findByRole('button', { name: /^Open in graph/ });
    selector.focus();
    const user = userEvent.setup();
    const stops = [selector.getAttribute('aria-label')];
    for (let press = 0; press < 3; press += 1) {
      await user.tab();
      const active = document.activeElement;
      stops.push(active?.getAttribute('aria-label') ?? active?.textContent ?? '');
    }
    expect(stops.slice(0, 3)).toEqual(['Source', 'Search text', 'Search']);
    expect(stops[3]).toMatch(/^Open in graph/);
  });
});
