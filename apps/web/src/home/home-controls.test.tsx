import { configure, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { knowing } from '../investigations/test-data.js';
import { me, renderApp, source } from '../test-utils.js';

beforeAll(() => configure({ reactStrictMode: true }));
afterAll(() => configure({ reactStrictMode: false }));

const twoSources = { getSources: async () => ({ ok: true as const, value: { items: [source('source-a'), source('source-b')], nextCursor: null } }) };
const down = { ok: false as const, failure: { code: 'NETWORK_UNAVAILABLE' as const } };

describe('the buttons of Home', () => {
  it('marks Search and the Open buttons of the prompt primary and the entry action link-style', async () => {
    renderApp('/', knowing([], twoSources).client);
    const search = await screen.findByRole('button', { name: 'Search' });
    expect(search.className).toBe('primary');
    const entry = screen.getByRole('button', { name: 'Open a deep link' });
    expect(entry.className).toBe('link');
    await userEvent.setup().click(entry);
    const opens = [screen.getByRole('form', { name: 'Open a link' }), screen.getByRole('form', { name: 'Open by parts' })].map((form) => within(form).getByRole('button', { name: 'Open' }));
    expect(opens.map((button) => button.className)).toEqual(['primary', 'primary']);
  });

  it('marks the Try again of a failed list and of a failed source read secondary', async () => {
    renderApp('/', knowing([], { ...twoSources, listInvestigations: async () => down }).client);
    expect((await screen.findByRole('button', { name: 'Try again' })).className).toBe('secondary');
    const failed = renderApp('/', knowing([], { getSources: async () => down }).client);
    const buttons = await screen.findAllByRole('button', { name: 'Try again' });
    expect(buttons.map((button) => button.className)).toContain('secondary');
    failed.unmount();
  });

  it('keeps the tab order: the source selector, the search box, Search, then the entry action', async () => {
    renderApp('/', knowing([], { ...twoSources, getMe: async () => ({ ok: true as const, value: me() }) }).client);
    const user = userEvent.setup();
    const selector = await screen.findByRole('combobox', { name: 'Source' });
    selector.focus();
    const stops = [selector.getAttribute('aria-label')];
    for (let press = 0; press < 3; press += 1) {
      await user.tab();
      const active = document.activeElement;
      stops.push(active?.getAttribute('aria-label') ?? active?.textContent ?? '');
    }
    expect(stops).toEqual(['Source', 'Search text', 'Search', 'Open a deep link']);
  });
});
