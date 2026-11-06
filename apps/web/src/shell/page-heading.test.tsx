import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { fakeClient } from '../api/fake-client.js';
import { createClientState } from '../state/client-state.js';
import { ClientStateProvider } from '../state/context.js';
import { clientWith, me, renderApp, source } from '../test-utils.js';
import { PageHeading } from './page-heading.js';
import { createShellData, ShellDataProvider, useShellData } from './shell-data.js';

const heading = () => screen.getByRole('heading', { level: 1 });
const header = () => {
  const found = document.querySelector<HTMLElement>('.page-heading');
  if (found === null) throw new Error('the page has no heading block');
  return within(found);
};
const badge = () => header().queryByText('Synthetic data');
const sourceName = (text: string) => header().queryByText(text);
/** Both reads have answered (or failed): the sidebar shows no loading state any more. */
const answered = () => waitFor(() => expect(screen.queryAllByRole('status').filter((status) => status.textContent !== '')).toHaveLength(0));

describe('the page heading', () => {
  it.each([
    ['/', 'Home'],
    ['/investigations', 'Investigations'],
    ['/sources', 'Sources'],
    ['/nowhere', 'Page not found'],
  ])('starts the page at %s with a single level-1 heading and a description', async (path, title) => {
    renderApp(path, clientWith({ me: me(), sources: [source('a')] }));
    await answered();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(heading().textContent).toBe(title);
    expect(document.querySelector('.page-heading > p')?.textContent?.length).toBeGreaterThan(0);
  });

  it('names the source in view under the title, with the Synthetic data badge, a text label, beside it when the data is synthetic', async () => {
    const view = renderApp('/', clientWith({ me: me(), sources: [source('a', { alias: 'banking', synthetic: true })] }));
    expect(await screen.findByText('Synthetic data')).toBeTruthy();
    expect(sourceName('banking · read-only')).toBeTruthy();
    view.unmount();
    renderApp('/', clientWith({ me: me(), sources: [source('a', { alias: 'banking', synthetic: false })] }));
    await answered();
    expect(sourceName('banking · read-only')).toBeTruthy();
    expect(badge()).toBeNull();
  });

  it('shows a long unbroken source name whole in the heading', async () => {
    const alias = 'b'.repeat(120);
    renderApp('/', clientWith({ me: me(), sources: [source('a', { alias })] }));
    expect(await header().findByText(`${alias} · read-only`)).toBeTruthy();
  });

  it('with several sources and none current, names none and shows the badge only when every one is synthetic: a mix, and an empty list, show none', async () => {
    const all = renderApp('/', clientWith({ me: me(), sources: [source('a'), source('b')] }));
    expect(await screen.findByText('Synthetic data')).toBeTruthy();
    expect(header().queryByText(/read-only/)).toBeNull();
    all.unmount();
    const mix = renderApp('/', clientWith({ me: me(), sources: [source('a'), source('b', { synthetic: false })] }));
    await answered();
    expect(badge()).toBeNull();
    mix.unmount();
    renderApp('/', clientWith({ me: me(), sources: [] }));
    await answered();
    expect(badge()).toBeNull();
    expect(document.querySelector('.source-note')).toBeNull();
  });

  it('follows the bound source: a synthetic one shows the badge although another is real, and a real one hides it although another is synthetic', async () => {
    const synthetic = createClientState();
    synthetic.bindSource('fake');
    const first = renderApp('/', clientWith({ me: me(), sources: [source('fake'), source('real', { synthetic: false })] }), synthetic);
    expect(await screen.findByText('Synthetic data')).toBeTruthy();
    first.unmount();
    const real = createClientState();
    real.bindSource('real');
    const second = renderApp('/', clientWith({ me: me(), sources: [source('fake'), source('real', { synthetic: false })] }), real);
    await answered();
    expect(badge()).toBeNull();
    expect(sourceName('Source real · read-only')).toBeTruthy();
    second.unmount();
    const missing = createClientState();
    missing.bindSource('missing');
    renderApp('/', clientWith({ me: me(), sources: [source('fake')] }), missing);
    await answered();
    expect(badge()).toBeNull();
  });

  it('shows the title and the description alone while both reads are awaited, and when both have failed', async () => {
    const loading = renderApp('/', fakeClient({ getMe: () => new Promise(() => undefined), getSources: () => new Promise(() => undefined) }));
    expect(heading().textContent).toBe('Home');
    expect(badge()).toBeNull();
    loading.unmount();
    renderApp('/', fakeClient());
    await screen.findAllByRole('alert');
    expect(badge()).toBeNull();
    expect(document.querySelector('.source-note')).toBeNull();
    expect(heading().textContent).toBe('Home');
  });

  it('shows no badge when the sources fail, and the source and the badge when the principal fails', async () => {
    const sourcesFail = renderApp('/', clientWith({ me: me() }));
    await screen.findAllByRole('alert');
    expect(badge()).toBeNull();
    sourcesFail.unmount();
    renderApp('/', clientWith({ sources: [source('a')] }));
    expect(await screen.findByText('Synthetic data')).toBeTruthy();
  });
});

function Reloader() {
  const { reload } = useShellData();
  return <button onClick={reload}>Reload</button>;
}

describe('the page heading after a later failure', () => {
  it.each([
    ['principal', true],
    ['sources', false],
  ] as const)('keeps what it showed when only the %s read fails on a later read', async (failing, meFails) => {
    let reads = 0;
    const down = { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } } as const;
    const client = fakeClient({
      getMe: async () => (meFails && reads > 0 ? down : { ok: true, value: me() }),
      getSources: async () => {
        const first = reads++ === 0;
        return !meFails && !first ? down : { ok: true, value: { items: [source('a')], nextCursor: null } };
      },
    });
    render(
      <ClientStateProvider state={createClientState()}>
        <ShellDataProvider store={createShellData(client)}>
          <Reloader />
          <PageHeading title="Home" description="A page." />
        </ShellDataProvider>
      </ClientStateProvider>,
    );
    expect(await screen.findByText('Synthetic data')).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(reads).toBe(2));
    await act(async () => undefined);
    expect(screen.getByText('Synthetic data'), failing).toBeTruthy();
    expect(screen.getByText('Source a · read-only'), failing).toBeTruthy();
  });

  it('keeps the source and the badge when both reads fail after they answered', async () => {
    let reads = 0;
    const down = { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } } as const;
    const client = fakeClient({
      getMe: async () => (reads === 0 ? { ok: true, value: me() } : down),
      getSources: async () => (reads++ === 0 ? { ok: true, value: { items: [source('a')], nextCursor: null } } : down),
    });
    render(
      <ClientStateProvider state={createClientState()}>
        <ShellDataProvider store={createShellData(client)}>
          <Reloader />
          <PageHeading title="Home" description="A page." />
        </ShellDataProvider>
      </ClientStateProvider>,
    );
    expect(await screen.findByText('Synthetic data')).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(reads).toBe(2));
    await act(async () => undefined);
    expect(screen.getByText('Synthetic data')).toBeTruthy();
    expect(screen.getByText('Source a · read-only')).toBeTruthy();
  });
});

describe('the page heading of a page about a source that is not the one in view', () => {
  const headed = (synthetic: boolean) => (
    <ClientStateProvider state={createClientState()}>
      <ShellDataProvider store={createShellData(clientWith({ me: me(), sources: [source('a', { synthetic: !synthetic })] }))}>
        <PageHeading title="Search results" description="A page." source={{ alias: 'Own source', synthetic }} />
      </ShellDataProvider>
    </ClientStateProvider>
  );

  it('names the source it is given with its own badge, whatever the shell has in view', async () => {
    const first = render(headed(true));
    expect(await screen.findByText('Own source · read-only')).toBeDefined();
    expect(badge()).not.toBeNull();
    first.unmount();
    render(headed(false));
    expect(await screen.findByText('Own source · read-only')).toBeDefined();
    expect(badge()).toBeNull();
  });
});
