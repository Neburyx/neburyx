import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { okRun } from '../patterns-kit.js';
import { source } from '../../test-utils.js';
import { libraryPage, listed, page, settle, tab, tableRows, withDefinition } from './library-kit.js';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const HOLDS = listed({ id: '0192f000-0000-7000-8000-000000000001', name: 'Holds its start', kind: 'preset-run', presetId: 'shared-devices', templateId: 'shared-attribute', templateVersion: 1, params: {} });
const ASKS = listed({ id: '0192f000-0000-7000-8000-000000000002', name: 'Asks for its start', askForStartingEntity: true, anchor: null });
const OWN_DEFINITION = listed({ id: '0192f000-0000-7000-8000-000000000003', name: 'Own steps' });
const RETIRED = listed({ id: '0192f000-0000-7000-8000-000000000004', name: 'Retired', availability: { status: 'unavailable', reasons: [{ code: 'unknown-entity-type' }] } });
const answered = { runSavedPattern: async () => ({ ok: true as const, value: okRun(['acc-2']) }) };
const panel = () => screen.getByRole('complementary', { name: 'Patterns' });

describe('Run on a row of the library', () => {
  it('opens Explore on the source with the panel, and a saved pattern that holds its starting entity runs at once through the saved-run route', async () => {
    const kit = await libraryPage({ patterns: { listPatterns: async () => page([HOLDS]), ...answered } });
    await userEvent.click(screen.getByRole('button', { name: 'Run Holds its start' }));
    await settle();
    await settle();
    expect(kit.router.state.location.pathname).toBe('/explore');
    expect(panel()).toBeTruthy();
    const runs = kit.calls.filter((call) => call.method === 'runSavedPattern');
    expect(runs).toHaveLength(1);
    expect(runs[0]?.args[0]).toBe(HOLDS.id);
    expect(kit.state.presentation.view.getState().patternsSaved).toBeUndefined();
  });

  it('opens the start view of a saved pattern that asks for its starting entity, and runs nothing', async () => {
    const kit = await libraryPage({ patterns: { listPatterns: async () => page([ASKS]), ...answered } });
    await userEvent.click(screen.getByRole('button', { name: 'Run Asks for its start' }));
    await settle();
    await settle();
    expect(within(panel()).getByRole('button', { name: 'Run pattern' })).toBeTruthy();
    expect(kit.calls.filter((call) => call.method === 'runSavedPattern')).toHaveLength(0);
  });

  it('opens the form of a built-in pattern, as Home does, and the preview of a built-in definition', async () => {
    const kit = await libraryPage({ templates: async () => ({ ok: true, value: withDefinition() }) });
    await userEvent.click(tab(/^Built-in/));
    await userEvent.click(screen.getByRole('button', { name: 'Run Shared devices' }));
    await settle();
    await settle();
    expect(within(panel()).getByRole('button', { name: 'Shared devices', pressed: true })).toBeTruthy();
    await kit.router.navigate('/patterns');
    await settle();
    await userEvent.click(tab(/^Built-in/));
    await userEvent.click(screen.getByRole('button', { name: 'Run Fan-out' }));
    await settle();
    await settle();
    expect(within(panel()).getByRole('button', { name: 'Run pattern' })).toBeTruthy();
    expect(within(panel()).getAllByText('Fan-out').length).toBeGreaterThan(0);
  });

  it('sends nothing and makes no hand-off for an unavailable pattern', async () => {
    const kit = await libraryPage({ patterns: { listPatterns: async () => page([RETIRED]), ...answered } });
    await userEvent.click(screen.getByRole('button', { name: 'Run Retired' }));
    expect(kit.router.state.location.pathname).toBe('/patterns');
    expect(kit.state.presentation.view.getState().patternsSaved).toBeUndefined();
    expect(kit.calls.filter((call) => call.method === 'runSavedPattern')).toHaveLength(0);
  });

  it('shows no starting entity of a stored pattern, in a row, a menu or an attribute, whether or not masking is on, and still shows the permitted summary', async () => {
    const SECRET = 'SECRET-ACC-9';
    const held = { entityType: 'kind-a', stableId: SECRET };
    const rows = [listed({ id: HOLDS.id, name: 'Holds its start', kind: 'preset-run', presetId: 'shared-devices', templateId: 'shared-attribute', templateVersion: 1, params: { limit: 25 }, anchor: held }), listed({ id: '0192f000-0000-7000-8000-000000000008', name: 'Built with a start', anchor: held })];
    const kit = await libraryPage({ patterns: { listPatterns: async () => page(rows) } });
    for (const mask of [false, true]) {
      kit.state.setMask(mask);
      await settle();
      await userEvent.click(screen.getByRole('button', { name: 'More: Holds its start' }));
      expect(document.body.innerHTML).not.toContain(SECRET);
      await userEvent.keyboard('{Escape}');
      expect(document.body.innerHTML).not.toContain(SECRET);
      expect(tableRows()[0]).toContain('max 25');
    }
  });

  it('carries the mask of the session to the run', async () => {
    const kit = await libraryPage({ patterns: { listPatterns: async () => page([HOLDS]), ...answered } });
    kit.state.setMask(true);
    await settle();
    await userEvent.click(screen.getByRole('button', { name: 'Run Holds its start' }));
    await settle();
    await settle();
    expect(kit.calls.filter((call) => call.method === 'runSavedPattern')[0]?.args[1]).toEqual({ mask: true });
  });
});

describe('the way into the library from the panel', () => {
  it('opens the library on the source of the panel from an empty bare Explore, without asking for the source again, and keeps what Explore held', async () => {
    const kit = await libraryPage({ path: '/patterns?source=b', sources: [source('a'), source('b', { alias: 'Bravo' })], templates: async () => ({ ok: true, value: withDefinition() }), patterns: { listPatterns: async () => page([HOLDS]) } });
    await userEvent.click(tab(/^Built-in/));
    await userEvent.click(screen.getByRole('button', { name: 'Run Shared devices' }));
    await settle();
    await settle();
    const link = within(panel()).getByRole('link', { name: 'Open the patterns library' });
    expect(link.getAttribute('href')).toBe('/patterns?source=b');
    await userEvent.click(link);
    await settle();
    await settle();
    expect(kit.router.state.location.pathname + kit.router.state.location.search).toBe('/patterns?source=b');
    expect(screen.queryByRole('combobox', { name: 'Source' })).toBeNull();
    expect(tableRows()[0]).toContain('Holds its start');
  });
});
