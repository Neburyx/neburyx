import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { ApiClient } from './api/client.js';
import { fakeClient } from './api/fake-client.js';
import { appRoutes } from './routes.js';

const client: ApiClient = fakeClient({ getMe: () => new Promise(() => undefined) });

function renderAt(path: string) {
  const router = createMemoryRouter(appRoutes(client), { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

describe('routes and navigation', () => {
  it('moves to Sources when its link is reached with Tab and activated with Enter, and marks it as the current page', async () => {
    renderAt('/');
    const user = userEvent.setup();
    const sources = screen.getByRole('link', { name: 'Sources' });
    for (let presses = 0; presses < 10 && document.activeElement !== sources; presses += 1) await user.tab();
    expect(document.activeElement).toBe(sources);
    await user.keyboard('{Enter}');
    expect(screen.getByRole('heading', { name: 'Sources' })).toBeTruthy();
    expect(sources.getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Home' }).getAttribute('aria-current')).toBeNull();
  });

  it.each([
    ['/', 'Home'],
    ['/investigations', 'Investigations'],
    ['/sources', 'Sources'],
    ['/explore', 'Explore'],
  ])('shows its own page at %s, saying that it is not built yet', (path, title) => {
    renderAt(path);
    expect(screen.getByRole('heading', { name: title, level: 2 })).toBeTruthy();
    expect(screen.getByText('This screen is not built yet.')).toBeTruthy();
  });

  it('leaves Explore out of the navigation links', () => {
    renderAt('/explore');
    const names = screen.getAllByRole('link').map((link) => link.textContent);
    expect(names).toEqual(['Home', 'Investigations', 'Sources']);
  });

  it('shows a not-found page with a link back to Home for a path that matches none, and for an unknown path under a known one', async () => {
    renderAt('/nowhere');
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeTruthy();
    const back = screen.getByRole('link', { name: 'Back to Home' });
    await userEvent.setup().click(back);
    expect(screen.getByRole('heading', { name: 'Home', level: 2 })).toBeTruthy();
  });

  it('shows the not-found page for an unknown path below a known one', () => {
    renderAt('/sources/unknown');
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeTruthy();
  });

  it('treats a trailing slash as the same page', () => {
    renderAt('/sources/');
    expect(screen.getByRole('heading', { name: 'Sources', level: 2 })).toBeTruthy();
  });

  it('follows the history back and forward', async () => {
    const router = renderAt('/');
    const user = userEvent.setup();
    await user.click(screen.getByRole('link', { name: 'Sources' }));
    await user.click(screen.getByRole('link', { name: 'Investigations' }));
    await router.navigate(-1);
    expect(await screen.findByRole('heading', { name: 'Sources', level: 2 })).toBeTruthy();
    await router.navigate(1);
    expect(await screen.findByRole('heading', { name: 'Investigations', level: 2 })).toBeTruthy();
  });
});
