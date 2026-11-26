import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiFailure, ApiResult } from './api/client.js';
import { fakeClient } from './api/fake-client.js';
import { ProfileProvider } from './canvas/profile-context.js';
import type { ProfileState, ProfileStore } from './canvas/profile-store.js';
import { IdentityBlock } from './shell/identity-block.js';
import { createShellData, ShellDataProvider } from './shell/shell-data.js';
import { SourceLine } from './shell/source-line.js';
import { createClientState } from './state/client-state.js';
import { ClientStateProvider } from './state/context.js';
import { createStore, readable } from './state/store.js';
import { me, source } from './test-utils.js';
import { LegendPanel } from './workspace/legend-panel.js';
import { NoticeStrip } from './workspace/notice-strip.js';
import { RailIdentity } from './workspace/rail-identity.js';

afterEach(cleanup);

const OFFLINE: ApiFailure = { code: 'NETWORK_UNAVAILABLE' };
const GONE: ApiFailure = { code: 'NOT_FOUND', message: 'Not found.', retryable: false, traceId: 'trace-1' };

/** A read that fails with `failure` until `heal` is called, counting how often it is asked. */
function failing<T>(failure: ApiFailure, value: T) {
  let broken = true;
  let asked = 0;
  return {
    read: async (): Promise<ApiResult<T>> => {
      asked += 1;
      return broken ? { ok: false, failure } : { ok: true, value };
    },
    heal: () => {
      broken = false;
    },
    asked: () => asked,
  };
}

const SOURCES = { items: [source('a')], nextCursor: null };

function profileStore(request: ProfileState['request']) {
  const store = createStore<ProfileState>({ sourceId: 's', request });
  let reloads = 0;
  const profile: ProfileStore = {
    ...readable(store),
    reload: () => {
      reloads += 1;
    },
  };
  return { profile, reloads: () => reloads };
}

function shell(overrides: { readonly meRead?: ReturnType<typeof failing<ReturnType<typeof me>>>; readonly sourcesRead?: ReturnType<typeof failing<typeof SOURCES>> }, children: React.ReactNode, profile = profileStore({ phase: 'idle' }).profile) {
  const client = fakeClient({ getMe: overrides.meRead?.read ?? (async () => ({ ok: true, value: me() })), getSources: overrides.sourcesRead?.read ?? (async () => ({ ok: true, value: SOURCES })) });
  const state = createClientState();
  state.bindSource('s');
  return render(
    <ClientStateProvider state={state}>
      <ShellDataProvider store={createShellData(client)}>
        <ProfileProvider store={profile}>{children}</ProfileProvider>
      </ShellDataProvider>
    </ClientStateProvider>,
  );
}

describe('the Try again of the sidebar', () => {
  it.each([
    ['the source line', <SourceLine key="s" />, 'sourcesRead', 'Try again to read the sources', 'Unavailable · The server could not be reached.', /read-only/],
    ['the identity block', <IdentityBlock key="i" />, 'meRead', 'Try again to read your account', 'The server could not be reached.', 'Local workspace'],
  ] as const)('reads %s again, shows the failure again when it fails again, and the data when it succeeds', async (_name, place, which, button, sentence, data) => {
    const read = which === 'meRead' ? failing(OFFLINE, me()) : failing(OFFLINE, SOURCES);
    shell({ [which]: read }, place);
    const user = userEvent.setup();
    expect((await screen.findByRole('alert')).textContent).toBe(sentence);
    await user.click(screen.getByRole('button', { name: button }));
    expect(read.asked()).toBe(2);
    expect((await screen.findByRole('alert')).textContent).toBe(sentence);
    read.heal();
    screen.getByRole('button', { name: button }).focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByText(data)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each([
    ['the source line', <SourceLine key="s" />, 'sourcesRead'],
    ['the identity block', <IdentityBlock key="i" />, 'meRead'],
  ] as const)('shows no button in %s for a failure that asking again cannot help', async (_name, place, which) => {
    shell({ [which]: which === 'meRead' ? failing(GONE, me()) : failing(GONE, SOURCES) }, place);
    await screen.findByRole('alert');
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('the account that could not be read, on the rail', () => {
  it('is a button named by the sentence that opens the failure with its Try again, by Enter, and closes on Escape with the focus back on it', async () => {
    const read = failing(OFFLINE, me());
    shell({ meRead: read }, <RailIdentity />);
    const user = userEvent.setup();
    const button = await screen.findByRole('button', { name: 'The server could not be reached.' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('alert')).toBeNull();
    button.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('alert').textContent).toBe('The server could not be reached.');
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Try again to read your account' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.activeElement).toBe(button);
    await user.click(button);
    read.heal();
    await user.click(screen.getByRole('button', { name: 'Try again to read your account' }));
    expect(await screen.findByText('Local workspace')).toBeTruthy();
  });

  it('closes on a press outside it', async () => {
    shell({ meRead: failing(OFFLINE, me()) }, <RailIdentity />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'The server could not be reached.' }));
    await user.click(document.body);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('the notices of Explore', () => {
  it('give each read that failed a row of its own, named, with a Try again that repeats that read alone', async () => {
    const meRead = failing(OFFLINE, me());
    const sourcesRead = failing(OFFLINE, SOURCES);
    const held = profileStore({ phase: 'failed', failure: OFFLINE });
    shell({ meRead, sourcesRead }, <NoticeStrip />, held.profile);
    const strip = await screen.findByRole('group', { name: 'Notices' });
    await within(strip).findByRole('button', { name: 'Try again to read your account' });
    await within(strip).findByRole('button', { name: 'Try again to read the sources' });
    expect([...strip.querySelectorAll('.notice-lead')].map((lead) => lead.textContent)).toEqual(['Sources ·', 'Source profile ·', 'Your account ·']);
    const user = userEvent.setup();
    await user.click(within(strip).getByRole('button', { name: 'Try again to read the source profile' }));
    expect([held.reloads(), meRead.asked(), sourcesRead.asked()]).toEqual([1, 1, 1]);
    sourcesRead.heal();
    await user.click(within(strip).getByRole('button', { name: 'Try again to read the sources' }));
    expect(meRead.asked()).toBe(1);
    expect(within(strip).queryByRole('button', { name: 'Try again to read the sources' })).toBeNull();
  });

  it('shows a row with no button for a failure that asking again cannot help', async () => {
    shell({}, <NoticeStrip />, profileStore({ phase: 'failed', failure: GONE }).profile);
    await screen.findByRole('alert');
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('the entity types of the legend', () => {
  it('reads the profile again from their Try again', async () => {
    const held = profileStore({ phase: 'failed', failure: OFFLINE });
    shell({}, <LegendPanel />, held.profile);
    await act(async () => undefined);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again to read the entity types' }));
    expect(held.reloads()).toBe(1);
  });
});
