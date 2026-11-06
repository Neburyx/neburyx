import { configure, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INVESTIGATION_A, investigationOf, knowing, nodeOf } from '../investigations/test-data.js';
import { renderApp } from '../test-utils.js';

beforeAll(() => configure({ reactStrictMode: true }));
afterAll(() => configure({ reactStrictMode: false }));

const A = { investigation: investigationOf(INVESTIGATION_A, 'source-a', 'kind-a', 'A-1'), node: nodeOf('source-a', 'kind-a', 'A-1') };
const action = (): HTMLElement => screen.getByRole('button', { name: 'Open a deep link' });
const linkField = (): HTMLElement => within(screen.getByRole('form', { name: 'Open a link' })).getByLabelText('Link');
const openAndPaste = async (user: ReturnType<typeof userEvent.setup>, text: string): Promise<void> => {
  await user.click(action());
  await user.type(linkField(), text);
  await user.click(within(screen.getByRole('form', { name: 'Open a link' })).getByRole('button', { name: 'Open' }));
};

describe('the "Open a deep link" action on Home', () => {
  it('shows the prompt with the focus in its first field, and closes it by the action again or by Escape, giving the focus back to the action', async () => {
    renderApp('/', knowing([A]).client);
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Recent', level: 2 });
    expect(screen.queryByRole('form', { name: 'Open a link' })).toBeNull();
    await user.click(action());
    expect(screen.getByRole('form', { name: 'Open a link' })).toBeTruthy();
    expect(document.activeElement).toBe(linkField());
    expect(action().getAttribute('aria-expanded')).toBe('true');
    await user.click(action());
    expect(screen.queryByRole('form', { name: 'Open a link' })).toBeNull();
    expect(document.activeElement).toBe(action());
    await user.click(action());
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('form', { name: 'Open a link' })).toBeNull();
    expect(document.activeElement).toBe(action());
    expect(action().getAttribute('aria-expanded')).toBe('false');
  });

  it('opens the investigation of a pasted link with one open, as from the development page', async () => {
    const parts = knowing([A]);
    const view = renderApp('/', parts.client);
    await screen.findByRole('heading', { name: 'Recent', level: 2 });
    await openAndPaste(userEvent.setup(), '/source-a/entity/kind-a/A-1');
    await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
    expect(parts.calls.openInvestigation).toHaveLength(1);
    expect(view.router.state.location.pathname).toMatch(/^\/explore\/[0-9a-f-]{36}$/);
  });

  it.each([['another host', 'https://evil.example.test/source-a/entity/kind-a/A-1'], ['a javascript address', 'javascript:alert(1)'], ['text that is not a link', 'hello']])('shows the prompt\'s message and sends nothing for %s', async (_name, text) => {
    const parts = knowing([A]);
    const view = renderApp('/', parts.client);
    await screen.findByRole('heading', { name: 'Recent', level: 2 });
    await openAndPaste(userEvent.setup(), text);
    expect(await within(screen.getByRole('form', { name: 'Open a link' })).findByRole('alert')).toBeTruthy();
    expect(parts.calls.openInvestigation).toEqual([]);
    expect(view.router.state.location.pathname).toBe('/');
  });

  it('sends the open for a well-formed link to a source the person may not read, and shows the page for a link that cannot be opened', async () => {
    const sent: string[] = [];
    const parts = knowing([A], {
      openInvestigation: async (request) => {
        sent.push(request.sourceId);
        return { ok: false, failure: { code: 'NOT_FOUND', message: 'Not found.', retryable: false, traceId: 'tr-1' } };
      },
    });
    renderApp('/', parts.client);
    await screen.findByRole('heading', { name: 'Recent', level: 2 });
    await openAndPaste(userEvent.setup(), '/restricted/entity/kind-a/A-1');
    expect(await screen.findByRole('heading', { name: 'Nothing was found at this link', level: 1 })).toBeTruthy();
    expect(sent).toEqual(['restricted']);
  });

  it('offers no control for the demo case', async () => {
    renderApp('/', knowing([A]).client);
    await screen.findByRole('heading', { name: 'Recent', level: 2 });
    expect(screen.queryByRole('button', { name: /demo case/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /demo case/i })).toBeNull();
  });
});
