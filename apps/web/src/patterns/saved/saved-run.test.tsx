import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PATTERN_UNAVAILABLE_CODES, savedPatternSchema, type ListedPattern, type PatternListResponse, type SavedPatternRunResponse } from '@neburyx/contracts';
import type { ApiResult } from '../../api/client.js';
import { definitionHeavy, definitionOk, failure, heavyRun, listed, okRun, selectAccount, settle } from '../patterns-kit.js';
import { profiled } from '../../search/search-test-kit.js';
import { inRun, panelHeader } from '../run/run-kit.js';
import { openTab, savedWorkspace } from './saved-list.test.js';
import { UNAVAILABLE_TEXT } from './saved-copy.js';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const ID = '0192f000-0000-7000-8000-000000000001';
const page = (items: readonly ListedPattern[]): ApiResult<PatternListResponse> => ({ ok: true, value: { items: [...items], nextCursor: null } });
const runOf = (calls: ReturnType<typeof savedCalls>) => calls.filter((call) => call.method === 'runSavedPattern');
type Kit = Awaited<ReturnType<typeof savedWorkspace>>;
const savedCalls = (kit: Kit) => kit.patternCalls;
const press = async (name: string): Promise<void> => {
  await userEvent.click(screen.getByRole('button', { name }));
  await settle();
};
const subhead = (): string => document.querySelector('.patterns-subhead')?.textContent ?? '';
const back = async (): Promise<void> => {
  await userEvent.click(screen.getByRole('button', { name: 'Back to patterns' }));
  await settle();
};

describe('running a saved built pattern', () => {
  const ALPHA = (): ListedPattern => listed({ id: ID, name: 'Alpha' });
  const answering = { listPatterns: async () => page([ALPHA()]), runSavedPattern: async () => ({ ok: true as const, value: definitionOk(['acc-2']) }) };

  it('runs at once through the saved route with no anchor when the pattern holds its start, and shows the running screen and then the result of a built pattern', async () => {
    let finish: (answer: ApiResult<SavedPatternRunResponse>) => void = () => undefined;
    const kit = await savedWorkspace({ patterns: { listPatterns: answering.listPatterns, runSavedPattern: () => new Promise((resolve) => (finish = resolve)) } });
    await press('Run Alpha');
    const [call] = runOf(savedCalls(kit));
    expect(call?.args[0]).toBe(ID);
    expect(call?.args[1]).toEqual({});
    expect(typeof call?.args[2]).toBe('string');
    expect(panelHeader().title).toBe('Running pattern');
    expect(screen.getByRole('button', { name: 'Cancel run' })).toBeTruthy();
    await act(async () => finish({ ok: true, value: definitionOk(['acc-2']) }));
    await settle();
    expect(panelHeader().title).toBe('Pattern result');
    expect(subhead()).toBe('Alpha · from acc-1');
    expect(screen.getByRole('button', { name: /^Add (all|these) 1 to graph/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit pattern' })).toBeTruthy();
    expect(inRun().queryByRole('button', { name: /^Save/ })).toBeNull();
  });

  it('names a held start that is not on the canvas by its ID, or by its type when the type is keyed, since the stored ID is then a token', async () => {
    for (const keyed of [false, true]) {
      const kit = await savedWorkspace({
        nodes: [],
        opened: null,
        profile: async () => ({ ok: true, value: { ...profiled('a', ['kind-a', 'kind-b', 'kind-c']), entityTypes: profiled('a', ['kind-a', 'kind-b', 'kind-c']).entityTypes.map((type) => ({ ...type, keyed })) } }),
        patterns: answering,
      });
      await press('Run Alpha');
      expect(subhead()).toBe(keyed ? 'Alpha · from KIND-A' : 'Alpha · from acc-1');
      kit.unmount();
      cleanup();
      document.body.replaceChildren();
    }
  });

  it('carries the masking flag of the investigation', async () => {
    const kit = await savedWorkspace({ patterns: answering });
    act(() => kit.state.setMask(true));
    await settle();
    await press('Run Alpha');
    expect(runOf(savedCalls(kit))[0]?.args[1]).toEqual({ mask: true });
  });

  it('shows the start screen first when the pattern asks each time, prefilled from a selected entity of the start type, and sends it as the anchor', async () => {
    const kit = await savedWorkspace({ opened: null, patterns: { listPatterns: async () => page([listed({ id: ID, name: 'Alpha', askForStartingEntity: true, anchor: null })]), runSavedPattern: answering.runSavedPattern } });
    await press('Run Alpha');
    expect(runOf(savedCalls(kit))).toHaveLength(0);
    expect(panelHeader().title).toBe('Preview pattern');
    expect(subhead()).toBe('Alpha');
    expect((screen.getByRole('button', { name: 'Run pattern' }) as HTMLButtonElement).disabled).toBe(true);
    await back();
    selectAccount(kit.state, 'acc-2');
    await settle();
    await press('Run Alpha');
    expect((screen.getByRole('button', { name: 'Run pattern' }) as HTMLButtonElement).disabled).toBe(false);
    await press('Run pattern');
    expect(runOf(savedCalls(kit))[0]?.args[1]).toEqual({ anchor: { entityType: 'kind-a', stableId: 'acc-2' } });
    expect(panelHeader().title).toBe('Pattern result');
  });

  it('shows the heavy screen and continues with the page the server offered', async () => {
    const kit = await savedWorkspace({ patterns: { listPatterns: answering.listPatterns, runSavedPattern: async (_id, request) => ({ ok: true, value: request.continue === true ? definitionOk(['acc-2']) : definitionHeavy() }) } });
    await press('Run Alpha');
    expect(panelHeader().title).toBe('Run paused');
    expect(screen.getByText('Estimated ≥ 500 matches')).toBeTruthy();
    await userEvent.click(screen.getAllByRole('button', { name: 'Continue with 25' })[0] as HTMLElement);
    await settle();
    expect(runOf(savedCalls(kit))[1]?.args[1]).toEqual({ continue: true, limit: 25 });
    expect(panelHeader().title).toBe('Pattern result');
  });

  it('asks the next page with the cursor of the page before', async () => {
    const kit = await savedWorkspace({ patterns: { listPatterns: answering.listPatterns, runSavedPattern: async (_id, request) => ({ ok: true, value: definitionOk(['acc-2'], request.cursor === undefined ? { nextCursor: 'c-1' } : {}) }) } });
    await press('Run Alpha');
    await press('Next');
    expect(runOf(savedCalls(kit))[1]?.args[1]).toEqual({ cursor: 'c-1' });
  });

  it('aborts a run that is cancelled, says so on the start screen with Run again, and adds nothing', async () => {
    let signal: AbortSignal | undefined;
    await savedWorkspace({
      patterns: {
        listPatterns: answering.listPatterns,
        runSavedPattern: (_id, _request, _key, given) => {
          signal = given;
          return new Promise(() => undefined);
        },
      },
    });
    await press('Run Alpha');
    await press('Cancel run');
    expect(signal?.aborted).toBe(true);
    expect(screen.getByText(/^Run cancelled\./)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Run again' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Add / })).toBeNull();
  });

  it('aborts a run on its way when the person goes back to the list, and when the panel is closed', async () => {
    const signals: AbortSignal[] = [];
    await savedWorkspace({
      patterns: {
        listPatterns: answering.listPatterns,
        runSavedPattern: (_id, _request, _key, given) => {
          if (given !== undefined) signals.push(given);
          return new Promise(() => undefined);
        },
      },
    });
    await press('Run Alpha');
    await back();
    expect(signals[0]?.aborted).toBe(true);
    expect(screen.getByRole('searchbox', { name: 'Search patterns' })).toBeTruthy();
    await press('Run Alpha');
    await userEvent.click(screen.getByRole('button', { name: 'Close Patterns' }));
    expect(signals[1]?.aborted).toBe(true);
  });

  it('says a failure in words, keeps the run view on screen and offers Try again', async () => {
    let calls = 0;
    await savedWorkspace({ patterns: { listPatterns: answering.listPatterns, runSavedPattern: async () => (++calls === 1 ? { ok: false, failure: failure('SOURCE_BUSY') } : { ok: true, value: definitionOk(['acc-2']) }) } });
    await press('Run Alpha');
    expect(screen.getAllByRole('alert').map((entry) => entry.textContent).join(' ')).toMatch(/busy/i);
    expect(panelHeader().title).toBe('Preview pattern');
    expect(screen.getByRole('button', { name: 'Back to patterns' })).toBeTruthy();
    await press('Try again');
    expect(panelHeader().title).toBe('Pattern result');
  });

  it('runs another person’s shared pattern with the same request, under the person’s own session', async () => {
    const kit = await savedWorkspace({ patterns: { listPatterns: async () => page([listed({ id: ID, name: 'Beta', ownedByYou: false, visibility: 'shared', owner: { name: 'Pat' } })]), runSavedPattern: answering.runSavedPattern } });
    await press('Run Beta');
    expect(runOf(savedCalls(kit))[0]?.args[1]).toEqual({});
  });

  it('opens the editor from Edit pattern: the person’s own pattern for a change, another person’s as a new draft', async () => {
    await savedWorkspace({ patterns: answering });
    await press('Run Alpha');
    await press('Edit pattern');
    expect(screen.getByRole('heading', { name: 'Change pattern: Alpha' })).toBeTruthy();
    cleanup();
    document.body.replaceChildren();
    await savedWorkspace({ patterns: { listPatterns: async () => page([listed({ id: ID, name: 'Beta', ownedByYou: false, visibility: 'shared', owner: { name: 'Pat' } })]), runSavedPattern: answering.runSavedPattern } });
    await press('Run Beta');
    await press('Edit pattern');
    expect(screen.getByRole('heading', { name: 'New pattern' })).toBeTruthy();
  });
});

describe('running a saved run of a built-in pattern', () => {
  const preset = (): ListedPattern => listed({ id: ID, name: 'Devices', kind: 'preset-run', presetId: 'shared-devices', templateId: 'shared-attribute', templateVersion: 1, params: {} });

  it('shows the kind line with the built-in pattern’s name and answers as a preset answers', async () => {
    const kit = await savedWorkspace({ patterns: { listPatterns: async () => page([preset()]), runSavedPattern: async () => ({ ok: true, value: okRun(['acc-2']) }) } });
    await openTab(/My patterns/);
    expect(within(screen.getByRole('region', { name: /My patterns/ })).getByText(/^Shared devices/)).toBeTruthy();
    await press('Run Devices');
    expect(runOf(savedCalls(kit))[0]?.args[1]).toEqual({});
    expect(within(screen.getByRole('region', { name: 'Result' })).getByRole('button', { name: 'Add to graph' })).toBeTruthy();
  });

  it('shows the heavy stop with the preset’s banner and continues', async () => {
    const kit = await savedWorkspace({ patterns: { listPatterns: async () => page([preset()]), runSavedPattern: async (_id, request) => ({ ok: true, value: (request.continue === true ? okRun(['acc-2']) : heavyRun()) }) } });
    await openTab(/My patterns/);
    await press('Run Devices');
    await press('Continue with 25');
    expect(runOf(savedCalls(kit))[1]?.args[1]).toEqual({ continue: true, limit: 25 });
  });

  it('shows an answer of the wrong shape as a mismatch, never as a result', async () => {
    await savedWorkspace({ patterns: { listPatterns: async () => page([preset()]), runSavedPattern: async () => ({ ok: true, value: definitionOk(['acc-2']) }) } });
    await openTab(/My patterns/);
    await press('Run Devices');
    expect(screen.queryByRole('region', { name: 'Result' })).toBeNull();
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
  });
});

describe('a saved pattern that cannot run', () => {
  const reasons = PATTERN_UNAVAILABLE_CODES.map((code) => ({ code }));
  const gone = (overrides: Record<string, unknown> = {}): ListedPattern => listed({ id: ID, name: 'Alpha', availability: { status: 'unavailable', reasons: [{ code: 'unknown-property', path: ['steps', 1, 'conditions', 0] }] }, ...overrides });

  it('says Pattern out of date with a sentence for the reason and the step, disables Run with that reason, and offers Change pattern for the person’s own pattern', async () => {
    await savedWorkspace({ patterns: { listPatterns: async () => page([gone()]) } });
    const panel = within(screen.getByRole('region', { name: /My patterns/ }));
    expect(panel.getByText('Pattern out of date')).toBeTruthy();
    expect(panel.getByText(`${UNAVAILABLE_TEXT['unknown-property']} (step 2)`)).toBeTruthy();
    const run = panel.getByRole('button', { name: 'Run Alpha' }) as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    expect(run.getAttribute('aria-describedby')).toBeTruthy();
    expect(panel.getByRole('button', { name: 'Change pattern' })).toBeTruthy();
    expect(panel.queryByRole('button', { name: 'Copy and change' })).toBeNull();
  });

  it('offers Copy and change for another person’s shared pattern, which copies it and opens the copy for a change', async () => {
    const copied = savedPatternSchema.parse({ id: '0192f000-0000-7000-8000-0000000000c1', sourceId: 'a', name: 'Beta (copy)', askForStartingEntity: true, anchor: null, visibility: 'private', lastRunAt: null, createdAt: '2026-11-12T10:00:00.000Z', updatedAt: '2026-11-12T10:00:00.000Z', version: 1, kind: 'definition', definition: { anchorType: 'kind-a', steps: [{ relationshipTypes: ['link-a'], direction: 'out', arrivesAt: 'kind-b' }] } });
    const kit = await savedWorkspace({ patterns: { listPatterns: async () => page([gone({ name: 'Beta', ownedByYou: false, visibility: 'shared', owner: { name: 'Pat' } })]), copyPattern: async () => ({ ok: true, value: copied }) } });
    const panel = within(screen.getByRole('region', { name: /Shared on this source/ }));
    expect(panel.queryByRole('button', { name: 'Change pattern' })).toBeNull();
    await userEvent.click(panel.getByRole('button', { name: 'Copy and change' }));
    await settle();
    expect(kit.patternCalls.filter((call) => call.method === 'copyPattern')[0]?.args[0]).toBe(ID);
    expect(screen.getByRole('heading', { name: 'Change pattern: Beta (copy)' })).toBeTruthy();
  });

  it('opens the editor for a change from Change pattern', async () => {
    await savedWorkspace({ patterns: { listPatterns: async () => page([gone()]) } });
    await userEvent.click(screen.getByRole('button', { name: 'Change pattern' }));
    await settle();
    expect(screen.getByRole('heading', { name: 'Change pattern: Alpha' })).toBeTruthy();
  });

  it('has a sentence in words for each of the reason codes, and none holds a code or a name', async () => {
    await savedWorkspace({ patterns: { listPatterns: async () => page([listed({ id: ID, name: 'Alpha', availability: { status: 'unavailable', reasons } })]) } });
    const panel = within(screen.getByRole('region', { name: /My patterns/ }));
    for (const code of PATTERN_UNAVAILABLE_CODES) {
      expect(panel.getByText(UNAVAILABLE_TEXT[code])).toBeTruthy();
      expect(UNAVAILABLE_TEXT[code]).not.toContain(code);
    }
  });

  it('shows Pattern out of date in the run view when the run route says so, with Run off and no result, and reads the list again so that the row says it too', async () => {
    let reads = 0;
    const kit = await savedWorkspace({
      patterns: {
        listPatterns: async () => page([++reads === 1 ? listed({ id: ID, name: 'Alpha' }) : gone({ availability: { status: 'unavailable', reasons: [{ code: 'unknown-entity-type' }] } })]),
        runSavedPattern: async () => ({ ok: true, value: { status: 'unavailable', reasons: [{ code: 'unknown-entity-type' }] } }),
      },
    });
    await press('Run Alpha');
    expect(panelHeader().title).toBe('Pattern out of date');
    expect(inRun().getByText(UNAVAILABLE_TEXT['unknown-entity-type'])).toBeTruthy();
    expect((inRun().getByRole('button', { name: 'Run pattern' }) as HTMLButtonElement).disabled).toBe(true);
    expect(inRun().getByRole('button', { name: 'Change pattern' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Add / })).toBeNull();
    expect(kit.patternCalls.filter((call) => call.method === 'listPatterns')).toHaveLength(2);
    await back();
    expect((within(screen.getByRole('region', { name: /My patterns/ })).getByRole('button', { name: 'Run Alpha' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('says the same of a saved run of a built-in pattern, with nothing to change', async () => {
    await savedWorkspace({ patterns: { listPatterns: async () => page([listed({ id: ID, name: 'Devices', kind: 'preset-run', presetId: 'shared-devices', templateId: 'shared-attribute', templateVersion: 1, params: {} })]), runSavedPattern: async () => ({ ok: true, value: { status: 'unavailable', reasons: [{ code: 'preset-removed' }] } }) } });
    await press('Run Devices');
    expect(screen.getByText(UNAVAILABLE_TEXT['preset-removed'])).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Change pattern' })).toBeNull();
  });
});

describe('what a run leaves in the list', () => {
  it('marks the last run of the person’s own pattern after a result, without reading the list again, and the pages already read stay', async () => {
    const kit = await savedWorkspace({ patterns: { listPatterns: async () => page([listed({ id: ID, name: 'Alpha' })]), runSavedPattern: async () => ({ ok: true, value: definitionOk(['acc-2']) }) } });
    expect(screen.getByText(/Not run yet/)).toBeTruthy();
    await press('Run Alpha');
    await back();
    expect(screen.getByText(new RegExp(`Last run ${new Date().toISOString().slice(0, 10)} UTC`))).toBeTruthy();
    expect(kit.patternCalls.filter((call) => call.method === 'listPatterns')).toHaveLength(1);
  });

  it('runs a pattern read on a later page', async () => {
    const LATER = '0192f000-0000-7000-8000-000000000009';
    await savedWorkspace({
      patterns: {
        listPatterns: async (query) => (query.cursor === undefined ? { ok: true, value: { items: [listed({ id: ID, name: 'Alpha' })], nextCursor: 'next-1' } } : page([listed({ id: LATER, name: 'Omega' })])),
        runSavedPattern: async () => ({ ok: true, value: definitionOk(['acc-2']) }),
      },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await settle();
    await press('Run Omega');
    expect(panelHeader().title).toBe('Pattern result');
    await back();
    expect(within(screen.getByRole('region', { name: /My patterns/ })).getByText('Alpha')).toBeTruthy();
  });

  it('says a pattern that is gone in words, keeps the run view on screen, and reads the list again so that its row goes, when the run answers NOT_FOUND', async () => {
    let reads = 0;
    const kit = await savedWorkspace({
      patterns: {
        listPatterns: async () => page(++reads === 1 ? [listed({ id: ID, name: 'Beta', ownedByYou: false, visibility: 'shared', owner: { name: 'Pat' } })] : []),
        runSavedPattern: async () => ({ ok: false, failure: failure('NOT_FOUND') }),
      },
    });
    await press('Run Beta');
    expect(kit.patternCalls.filter((call) => call.method === 'listPatterns')).toHaveLength(2);
    expect(panelHeader().title).toBe('Preview pattern');
    expect(screen.getByText('This was not found. It may have been removed.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Back to patterns' })).toBeTruthy();
    await back();
    expect(screen.queryByRole('button', { name: 'Run Beta' })).toBeNull();
  });

  it('shows the run of a pattern of the person’s own under My patterns only, and the list as it was after Back', async () => {
    await savedWorkspace({ patterns: { listPatterns: async () => page([listed({ id: ID, name: 'Alpha' })]), runSavedPattern: async () => ({ ok: true, value: definitionOk(['acc-2']) }) } });
    await press('Run Alpha');
    await back();
    expect(within(screen.getByRole('region', { name: /My patterns/ })).getByText('Alpha')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: /Shared on this source/ })).queryByText('Alpha')).toBeNull();
  });
});
