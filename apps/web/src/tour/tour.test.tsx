import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PreferencesResponse, PreferencesWriteRequest } from '@neburyx/contracts';
import type { ApiClient, ApiResult } from '../api/client.js';
import { clientWith, me, renderApp, source } from '../test-utils.js';
import { LINK_NOT_FOUND_TITLE } from '../investigations/messages.js';
import { investigationOf, INVESTIGATION_A, knowing, nodeOf } from '../investigations/test-data.js';
import { TOUR_STEPS } from './tour-copy.js';
import { endTour, tourState } from './tour-store.js';

afterEach(() => endTour());

interface Prefs {
  readonly client: ApiClient;
  readonly puts: PreferencesWriteRequest[];
}

function withPreferences(read: () => Promise<ApiResult<PreferencesResponse>>, write: (body: PreferencesWriteRequest) => Promise<ApiResult<PreferencesResponse>>, parts: Parameters<typeof clientWith>[0]): Prefs {
  const puts: PreferencesWriteRequest[] = [];
  const base = clientWith(parts);
  return {
    puts,
    client: {
      ...base,
      getPreferences: read,
      putPreferences: (body) => {
        puts.push(body);
        return write(body);
      },
    },
  };
}

const NO_TOUR = async (): Promise<ApiResult<PreferencesResponse>> => ({ ok: true, value: { preferences: {} } });
const STORED = (tour: 'completed' | 'skipped') => async (): Promise<ApiResult<PreferencesResponse>> => ({ ok: true, value: { preferences: { tour } } });
const ECHO = async (body: PreferencesWriteRequest): Promise<ApiResult<PreferencesResponse>> => ({ ok: true, value: { preferences: body.preferences } });
const FAILS = async (): Promise<ApiResult<PreferencesResponse>> => ({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } });
const DEMO = { entityType: 'thing', stableId: 'D-1', caseRef: 'DEMO' };

const A = { investigation: investigationOf(INVESTIGATION_A, 'source-a', 'kind-a', 'A-1', { caseRef: 'CASE-1' }), node: nodeOf('source-a', 'kind-a', 'A-1') };
const A_DEMO = { entityType: 'kind-a', stableId: 'A-1', caseRef: 'CASE-1' };

/** A client whose demo case opens (the entity is known) or is not found (nothing is known), with the preferences faked. */
function demoOpening(known: typeof A[], overrides: Partial<ApiClient> = {}): Prefs {
  const puts: PreferencesWriteRequest[] = [];
  const base = knowing(known, { getSources: async () => ({ ok: true, value: { items: [source('source-a', { demoCase: A_DEMO })], nextCursor: null } }), ...overrides }).client;
  return {
    puts,
    client: {
      ...base,
      getPreferences: FAILS,
      putPreferences: (body) => {
        puts.push(body);
        return ECHO(body);
      },
    },
  };
}

const dialog = (step: number) => screen.findByRole('dialog', { name: `Guided tour, step ${step} of 4` });

async function startFromHelp(): Promise<void> {
  await userEvent.click(await screen.findByRole('button', { name: 'Help' }));
  await userEvent.click(screen.getByRole('menuitem', { name: /Take the tour/ }));
}

describe('the tour on Home (step 1)', () => {
  it('starts from the first Help item and shows the copy, the dots and the buttons as the design draws them', async () => {
    const { client } = withPreferences(FAILS, ECHO, { me: me(), sources: [source('a')] });
    const measured = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 100, top: 100, width: 300, height: 40, right: 400, bottom: 140, x: 100, y: 100, toJSON: () => ({}) });
    renderApp('/', client);
    await userEvent.click(await screen.findByRole('button', { name: 'Help' }));
    expect(within(screen.getByRole('menu', { name: 'Help' })).getAllByRole('menuitem')[0]?.textContent).toBe('Take the tour');
    await userEvent.click(screen.getByRole('menuitem', { name: /Take the tour/ }));
    const box = await dialog(1);
    expect(within(box).getByText('STEP 1 OF 4')).toBeTruthy();
    expect(within(box).getByRole('heading', { name: 'Start with an entity' })).toBeTruthy();
    expect(within(box).getByText(TOUR_STEPS[0]?.body ?? '')).toBeTruthy();
    expect(box.querySelectorAll('.tour-dot')).toHaveLength(4);
    expect(box.querySelectorAll('.tour-dot-on')).toHaveLength(1);
    expect(within(box).getAllByRole('button').map((button) => button.textContent)).toEqual(['Skip tour', 'Next']);
    expect(document.querySelector('.tour-spot')).not.toBeNull();
    measured.mockRestore();
  });

  it('moves the focus into the popover and back to the Help button when it closes', async () => {
    const { client } = withPreferences(FAILS, ECHO, { me: me(), sources: [source('a')] });
    renderApp('/', client);
    await startFromHelp();
    const box = await dialog(1);
    await waitFor(() => expect(box.contains(document.activeElement)).toBe(true));
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Help' }));
  });

  it('keeps Tab and Shift+Tab among its controls', async () => {
    const { client } = withPreferences(FAILS, ECHO, { me: me(), sources: [source('a')] });
    renderApp('/', client);
    await startFromHelp();
    const box = await dialog(1);
    const skip = within(box).getByRole('button', { name: 'Skip tour' });
    const next = within(box).getByRole('button', { name: 'Next' });
    await waitFor(() => expect(document.activeElement).toBe(next));
    await userEvent.tab();
    expect(document.activeElement).toBe(skip);
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(next);
  });

  it('stores skipped through the preferences endpoint on Skip tour and on Esc, and closes at once', async () => {
    const { client, puts } = withPreferences(NO_TOUR, ECHO, { me: me(), sources: [source('a')] });
    renderApp('/', client);
    await startFromHelp();
    await userEvent.click(within(await dialog(1)).getByRole('button', { name: 'Skip tour' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(puts).toEqual([{ preferences: { tour: 'skipped' } }]);
  });

  it('closes at once and shows no notice when the store fails or is slow', async () => {
    const never = new Promise<ApiResult<PreferencesResponse>>(() => undefined);
    for (const write of [() => FAILS(), () => never]) {
      const { client, puts } = withPreferences(FAILS, write, { me: me(), sources: [source('a')] });
      const view = renderApp('/', client);
      await startFromHelp();
      const alerts = screen.queryAllByRole('alert').length;
      await userEvent.keyboard('{Escape}');
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(puts).toEqual([{ preferences: { tour: 'skipped' } }]);
      expect(screen.queryAllByRole('alert')).toHaveLength(alerts);
      view.unmount();
    }
  });

  it('shows the popover without a spotlight when its anchor is not on the page, and the step can still be skipped', async () => {
    const { client } = withPreferences(FAILS, ECHO, { me: me(), sources: [] });
    renderApp('/', client);
    await startFromHelp();
    await dialog(1);
    expect(document.querySelector('.tour-spot')).toBeNull();
    expect(document.querySelector('.tour-dim')).not.toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Skip tour' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('ends without storing anything when the person navigates away', async () => {
    const { client, puts } = withPreferences(FAILS, ECHO, { me: me(), sources: [source('a')] });
    const view = renderApp('/', client);
    await startFromHelp();
    await dialog(1);
    await act(async () => {
      await view.router.navigate('/sources');
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(puts).toEqual([]);
  });
});

describe('the tour moves on', () => {
  it('Next on step 1 opens the first demo case by its deep link', async () => {
    const { client } = withPreferences(FAILS, ECHO, { me: me(), sources: [source('a', { demoCase: DEMO }), source('b', { demoCase: { ...DEMO, stableId: 'D-2' } })] });
    const view = renderApp('/', client);
    await startFromHelp();
    await userEvent.click(within(await dialog(1)).getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(view.router.state.location.pathname).toBe('/a/entity/thing/D-1'));
  });

  it('shows step 2 when the demo case opens, on its investigation, with nothing stored', async () => {
    const { client, puts } = demoOpening([A]);
    const view = renderApp('/', client);
    await startFromHelp();
    await userEvent.click(within(await dialog(1)).getByRole('button', { name: 'Next' }));
    const box = await dialog(2);
    expect(within(box).getByRole('heading', { name: 'Read the network' })).toBeTruthy();
    expect(view.router.state.location.pathname).toBe(`/explore/${INVESTIGATION_A}`);
    expect(document.querySelector('.tour-dim')).not.toBeNull();
    expect(within(box).getByRole('button', { name: 'Next' })).toBeTruthy();
    expect(puts).toEqual([]);
  });

  it('ends the tour when the link is not found, with the page message left', async () => {
    const { client, puts } = demoOpening([]);
    renderApp('/', client);
    await startFromHelp();
    await userEvent.click(within(await dialog(1)).getByRole('button', { name: 'Next' }));
    await screen.findByRole('heading', { name: LINK_NOT_FOUND_TITLE, level: 1 });
    await waitFor(() => expect(tourState.getState().mode).toBe('off'));
    expect(puts).toEqual([]);
  });

  it('ends the tour when the open lands on an investigation that was already open (a held open), not on the demo case', async () => {
    const hold = new Promise<never>(() => undefined);
    const { client, puts } = demoOpening([A], { openInvestigation: () => hold });
    const view = renderApp('/', client);
    await startFromHelp();
    await userEvent.click(within(await dialog(1)).getByRole('button', { name: 'Next' }));
    await act(async () => {
      await view.router.navigate('/explore/0192f000-0000-7000-8000-0000000000bb', { replace: true });
    });
    await waitFor(() => expect(tourState.getState().mode).toBe('off'));
    expect(puts).toEqual([]);
  });

  it('keeps the waiting line on the bare Explore page, which has no investigation', async () => {
    const { client } = withPreferences(FAILS, ECHO, { me: me(), sources: [source('a')] });
    const view = renderApp('/', client);
    await startFromHelp();
    await userEvent.click(within(await dialog(1)).getByRole('button', { name: 'Next' }));
    await act(async () => {
      await view.router.navigate('/explore');
    });
    expect(screen.getByText('The tour continues when you open an investigation.')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('starts at step 1 on the current page, not on the address of an earlier tour', async () => {
    const { client } = withPreferences(FAILS, ECHO, { me: me(), sources: [source('a')] });
    const view = renderApp('/', client);
    await startFromHelp();
    await userEvent.click(within(await dialog(1)).getByRole('button', { name: 'Next' }));
    await act(async () => {
      await view.router.navigate('/explore/0192f000-0000-7000-8000-0000000000aa');
    });
    await userEvent.click(within(await dialog(2)).getByRole('button', { name: 'Skip tour' }));
    await act(async () => {
      await view.router.navigate('/');
    });
    await startFromHelp();
    await dialog(1);
    await act(async () => {
      await view.router.navigate('/explore/0192f000-0000-7000-8000-0000000000aa');
    });
    await waitFor(() => expect(tourState.getState().mode).toBe('off'));
  });

  it('ends the tour and stores nothing when the demo case cannot be opened, leaving the page failure', async () => {
    const { client, puts } = withPreferences(FAILS, ECHO, { me: me(), sources: [source('a', { demoCase: DEMO })] });
    renderApp('/', client);
    await startFromHelp();
    await userEvent.click(within(await dialog(1)).getByRole('button', { name: 'Next' }));
    await screen.findByRole('group', { name: 'Opening failed' });
    await waitFor(() => expect(tourState.getState().mode).toBe('off'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(puts).toEqual([]);
  });

  it('holds at a line with no demo case, keeps the tour through navigation, and shows step 2 when an investigation opens', async () => {
    const { client, puts } = withPreferences(FAILS, ECHO, { me: me(), sources: [source('a')] });
    const view = renderApp('/', client);
    await startFromHelp();
    await userEvent.click(within(await dialog(1)).getByRole('button', { name: 'Next' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('The tour continues when you open an investigation.')).toBeTruthy();
    await act(async () => {
      await view.router.navigate('/sources');
    });
    expect(screen.getByText('The tour continues when you open an investigation.')).toBeTruthy();
    await act(async () => {
      await view.router.navigate('/explore/0192f000-0000-7000-8000-0000000000aa');
    });
    const box = await dialog(2);
    expect(within(box).getByText('STEP 2 OF 4')).toBeTruthy();
    expect(within(box).getAllByRole('button').map((button) => button.textContent)).toEqual(['Skip tour', 'Back', 'Next']);
    expect(puts).toEqual([]);
  });

  it('Back on step 2 returns to Home and step 1', async () => {
    const { client } = withPreferences(FAILS, ECHO, { me: me(), sources: [source('a')] });
    const view = renderApp('/', client);
    await startFromHelp();
    await userEvent.click(within(await dialog(1)).getByRole('button', { name: 'Next' }));
    await act(async () => {
      await view.router.navigate('/explore/0192f000-0000-7000-8000-0000000000aa');
    });
    await userEvent.click(within(await dialog(2)).getByRole('button', { name: 'Back' }));
    await dialog(1);
    await waitFor(() => expect(view.router.state.location.pathname).toBe('/'));
    expect(tourState.getState()).toEqual({ mode: 'step', step: 0 });
  });

  it('stores skipped from the waiting line', async () => {
    const { client, puts } = withPreferences(FAILS, ECHO, { me: me(), sources: [source('a')] });
    renderApp('/', client);
    await startFromHelp();
    await userEvent.click(within(await dialog(1)).getByRole('button', { name: 'Next' }));
    await userEvent.click(screen.getByRole('button', { name: 'Skip tour' }));
    expect(screen.queryByText('The tour continues when you open an investigation.')).toBeNull();
    expect(puts).toEqual([{ preferences: { tour: 'skipped' } }]);
  });

  it('shows steps 3 and 4 with Back on each and Done on the last, which stores completed', async () => {
    const { client, puts } = withPreferences(FAILS, ECHO, { me: me(), sources: [source('a')] });
    const view = renderApp('/', client);
    await startFromHelp();
    await userEvent.click(within(await dialog(1)).getByRole('button', { name: 'Next' }));
    await act(async () => {
      await view.router.navigate('/explore/0192f000-0000-7000-8000-0000000000aa');
    });
    await userEvent.click(within(await dialog(2)).getByRole('button', { name: 'Next' }));
    const third = await dialog(3);
    expect(within(third).getByRole('heading', { name: 'Right-click for actions' })).toBeTruthy();
    // with no anchor on the page the step shows without a spotlight and can still be passed
    expect(document.querySelector('.tour-spot')).toBeNull();
    expect(document.querySelector('.tour-dim')).not.toBeNull();
    await userEvent.click(within(third).getByRole('button', { name: 'Next' }));
    const fourth = await dialog(4);
    expect(within(fourth).getByRole('heading', { name: 'Keep your work' })).toBeTruthy();
    expect(within(fourth).getAllByRole('button').map((button) => button.textContent)).toEqual(['Skip tour', 'Back', 'Done']);
    await userEvent.click(within(fourth).getByRole('button', { name: 'Back' }));
    await dialog(3);
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await userEvent.click(within(await dialog(4)).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(puts).toEqual([{ preferences: { tour: 'completed' } }]);
  });
});

describe('the automatic start', () => {
  it('starts once on Home when the preferences hold no tour', async () => {
    const { client } = withPreferences(NO_TOUR, ECHO, { me: me(), sources: [source('a')] });
    renderApp('/', client);
    expect(await dialog(1)).toBeTruthy();
  });

  it.each(['completed', 'skipped'] as const)('does not start when the tour is %s', async (value) => {
    const { client } = withPreferences(STORED(value), ECHO, { me: me(), sources: [source('a')] });
    renderApp('/', client);
    await screen.findByRole('button', { name: 'Help' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not start when the preferences cannot be read, and Home still works', async () => {
    const { client } = withPreferences(FAILS, ECHO, { me: me(), sources: [source('a')] });
    renderApp('/', client);
    await screen.findByRole('button', { name: 'Help' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByRole('dialog')).toBeNull();
    await startFromHelp();
    expect(await dialog(1)).toBeTruthy();
  });

  it('does not start away from Home', async () => {
    const { client } = withPreferences(NO_TOUR, ECHO, { me: me(), sources: [source('a')] });
    renderApp('/sources', client);
    await screen.findByRole('complementary');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('starts again at the next visit after a skip whose store failed', async () => {
    let stored: 'skipped' | undefined;
    const write = async (body: PreferencesWriteRequest): Promise<ApiResult<PreferencesResponse>> => {
      void body;
      return { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } };
    };
    const read = async (): Promise<ApiResult<PreferencesResponse>> => ({ ok: true, value: { preferences: stored === undefined ? {} : { tour: stored } } });
    const first = withPreferences(read, write, { me: me(), sources: [source('a')] });
    const view = renderApp('/', first.client);
    await userEvent.click(within(await dialog(1)).getByRole('button', { name: 'Skip tour' }));
    view.unmount();
    const second = withPreferences(read, ECHO, { me: me(), sources: [source('a')] });
    renderApp('/', second.client);
    expect(await dialog(1)).toBeTruthy();
  });
});
