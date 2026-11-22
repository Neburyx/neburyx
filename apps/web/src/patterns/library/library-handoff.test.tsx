import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { failure, listed, okRun, openPatterns, patternsWorkspace, settle } from '../patterns-kit.js';
import { profiled } from '../../search/search-test-kit.js';
import { page, withDefinition } from './library-kit.js';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const HOLDS = listed({ id: '0192f000-0000-7000-8000-000000000001', name: 'Holds its start', kind: 'preset-run', presetId: 'shared-devices', templateId: 'shared-attribute', templateVersion: 1, params: {} });
const OWN = listed({ id: '0192f000-0000-7000-8000-000000000003', name: 'Own steps' });
const answered = { runSavedPattern: async () => ({ ok: true as const, value: okRun(['acc-2']) }) };
const calls = (kit: Awaited<ReturnType<typeof patternsWorkspace>>, method: string) => kit.patternCalls.filter((call) => call.method === method);
const gone = 'That pattern is not there any more.';

describe('what the panel does with a saved pattern the library handed over', () => {
  it('runs a pattern found on the first page, once, and clears the hand-off', async () => {
    const kit = await patternsWorkspace({ patterns: { listPatterns: async () => page([HOLDS]), ...answered } });
    act(() => kit.state.presentation.setPatternsSaved({ id: HOLDS.id, action: 'run' }));
    await openPatterns();
    await settle();
    expect(calls(kit, 'runSavedPattern')).toHaveLength(1);
    expect(kit.state.presentation.view.getState().patternsSaved).toBeUndefined();
  });

  it('reads further pages until it finds the pattern, also behind a page that is empty while a cursor remains', async () => {
    let reads = 0;
    const kit = await patternsWorkspace({
      patterns: {
        listPatterns: async () => {
          reads += 1;
          if (reads === 1) return page([OWN], 'c1');
          if (reads === 2) return page([], 'c2');
          return page([HOLDS], null);
        },
        ...answered,
      },
    });
    act(() => kit.state.presentation.setPatternsSaved({ id: HOLDS.id, action: 'run' }));
    await openPatterns();
    await settle();
    await settle();
    await settle();
    expect(calls(kit, 'listPatterns')).toHaveLength(3);
    expect(calls(kit, 'runSavedPattern')).toHaveLength(1);
    expect(screen.queryByText(gone)).toBeNull();
  });

  it('drops a pattern that is not in the whole list, shows the list and says it is not there any more', async () => {
    const kit = await patternsWorkspace({ patterns: { listPatterns: async () => page([OWN]), ...answered } });
    act(() => kit.state.presentation.setPatternsSaved({ id: HOLDS.id, action: 'run' }));
    await openPatterns();
    await settle();
    expect(screen.getByText(gone)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Run Own steps' })).toBeTruthy();
    expect(calls(kit, 'runSavedPattern')).toHaveLength(0);
    expect(kit.state.presentation.view.getState().patternsSaved).toBeUndefined();
  });

  it('shows the list as read and not "not there any more" when a later page cannot be read', async () => {
    let reads = 0;
    const kit = await patternsWorkspace({ patterns: { listPatterns: async () => (++reads === 1 ? page([OWN], 'c1') : { ok: false, failure: failure('SOURCE_UNAVAILABLE') }), ...answered } });
    act(() => kit.state.presentation.setPatternsSaved({ id: HOLDS.id, action: 'run' }));
    await openPatterns();
    await settle();
    await settle();
    expect(screen.queryByText(gone)).toBeNull();
    expect(screen.getByRole('button', { name: 'Run Own steps' })).toBeTruthy();
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
    expect(calls(kit, 'runSavedPattern')).toHaveLength(0);
    expect(kit.state.presentation.view.getState().patternsSaved).toBeUndefined();
  });

  it('opens the builder on the stored definition for a Change', async () => {
    const kit = await patternsWorkspace({ patterns: { listPatterns: async () => page([OWN]) } });
    act(() => kit.state.presentation.setPatternsSaved({ id: OWN.id, action: 'change' }));
    await openPatterns();
    await settle();
    expect(within(screen.getByRole('complementary', { name: 'Patterns' })).getByLabelText('Starting entity type')).toBeTruthy();
  });
});

describe('what the panel does when what it needs to show the pattern is missing', () => {
  const ASKS = listed({ id: '0192f000-0000-7000-8000-000000000005', name: 'Asks', kind: 'preset-run', presetId: 'shared-devices', templateId: 'shared-attribute', templateVersion: 1, params: {}, askForStartingEntity: true, anchor: null });
  const RETIRED = listed({ id: '0192f000-0000-7000-8000-000000000006', name: 'Retired', kind: 'preset-run', presetId: 'shared-devices', templateId: 'shared-attribute', templateVersion: 1, params: {}, availability: { status: 'unavailable', reasons: [{ code: 'preset-removed' }] } });

  it('says a profile that cannot be read in words with Try again, and runs the definition once it can', async () => {
    let answered = false;
    const kit = await patternsWorkspace({
      patterns: { listPatterns: async () => page([OWN]) },
      profile: async () => (answered ? { ok: true, value: profiled('a', ['kind-a', 'kind-b', 'kind-c']) } : { ok: false, failure: failure('SOURCE_UNAVAILABLE') }),
    });
    act(() => kit.state.presentation.setPatternsSaved({ id: OWN.id, action: 'run' }));
    await openPatterns();
    await settle();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    answered = true;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await settle();
    await settle();
    expect(within(screen.getByRole('complementary', { name: 'Patterns' })).getByRole('button', { name: 'Run pattern' })).toBeTruthy();
  });

  it('says a template list that cannot be read in words with Try again for a saved built-in run that asks for its start', async () => {
    const kit = await patternsWorkspace({ list: async () => ({ ok: false, failure: failure('SOURCE_UNAVAILABLE') }), patterns: { listPatterns: async () => page([ASKS]) } });
    act(() => kit.state.presentation.setPatternsSaved({ id: ASKS.id, action: 'run' }));
    await openPatterns();
    await settle();
    await settle();
    expect(screen.getAllByRole('button', { name: 'Try again' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Back to patterns' })).toBeTruthy();
  });

  it('sends nothing for a pattern that was available on the page and is unavailable when the panel reads it, and says why', async () => {
    const kit = await patternsWorkspace({ patterns: { listPatterns: async () => page([RETIRED]), ...answered } });
    act(() => kit.state.presentation.setPatternsSaved({ id: RETIRED.id, action: 'run' }));
    await openPatterns();
    await settle();
    expect(calls(kit, 'runSavedPattern')).toHaveLength(0);
    expect(screen.getAllByText(/no longer in the mapping/).length).toBeGreaterThan(0);
  });
});

describe('what the panel does with a built-in definition the library handed over', () => {
  it('opens its preview for a run and an unsaved copy in the builder for a copy, and says a definition the list does not hold is not there any more', async () => {
    const kit = await patternsWorkspace({ list: async () => ({ ok: true, value: withDefinition() }) });
    act(() => kit.state.presentation.setPatternsBuiltIn({ id: 'fan-out', action: 'run' }));
    await openPatterns();
    await settle();
    expect(within(screen.getByRole('complementary', { name: 'Patterns' })).getByRole('button', { name: 'Run pattern' })).toBeTruthy();
    cleanup();
    const copied = await patternsWorkspace({ list: async () => ({ ok: true, value: withDefinition() }) });
    act(() => copied.state.presentation.setPatternsBuiltIn({ id: 'fan-out', action: 'copy' }));
    await openPatterns();
    await settle();
    expect(within(screen.getByRole('complementary', { name: 'Patterns' })).getByLabelText('Starting entity type')).toBeTruthy();
    expect(calls(copied, 'savePattern')).toHaveLength(0);
    cleanup();
    const missing = await patternsWorkspace({ list: async () => ({ ok: true, value: withDefinition() }) });
    act(() => missing.state.presentation.setPatternsBuiltIn({ id: 'nothing', action: 'run' }));
    await openPatterns();
    await settle();
    expect(screen.getByText(gone)).toBeTruthy();
  });
});
