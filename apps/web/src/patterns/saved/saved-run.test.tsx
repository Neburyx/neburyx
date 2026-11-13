import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PATTERN_UNAVAILABLE_CODES, type ListedPattern, type PatternListResponse, type SavedPatternRunResponse } from '@neburyx/contracts';
import type { ApiResult } from '../../api/client.js';
import { definitionHeavy, definitionOk, failure, heavyRun, listed, okRun, selectAccount, settle } from '../patterns-kit.js';
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
const result = (): HTMLElement => screen.getByRole('region', { name: 'Result' });

describe('running a saved built pattern', () => {
  it('sends the run with no starting entity when the pattern holds one, and shows the answer as a built pattern’s with Add to graph', async () => {
    const kit = await savedWorkspace({ patterns: { listPatterns: async () => page([listed({ id: ID, name: 'Alpha' })]), runSavedPattern: async () => ({ ok: true, value: definitionOk(['acc-2']) }) } });
    await openTab(/My patterns/);
    await press('Run Alpha');
    const [call] = runOf(savedCalls(kit));
    expect(call?.args[0]).toBe(ID);
    expect(call?.args[1]).toEqual({});
    expect(typeof call?.args[2]).toBe('string');
    expect(within(result()).getByRole('button', { name: 'Add to graph' })).toBeTruthy();
  });

  it('asks for the starting entity when the pattern asks each time, sends it as the anchor, and sends nothing without one', async () => {
    const kit = await savedWorkspace({ opened: null, patterns: { listPatterns: async () => page([listed({ id: ID, name: 'Alpha', askForStartingEntity: true, anchor: null })]), runSavedPattern: async () => ({ ok: true, value: definitionOk(['acc-2']) }) } });
    await openTab(/My patterns/);
    await press('Run Alpha');
    expect(runOf(savedCalls(kit))).toHaveLength(0);
    expect(screen.getByText('Choose the starting entity to run this pattern.')).toBeTruthy();
    const area = within(screen.getByRole('region', { name: 'Run: Alpha' }));
    expect((area.getByRole('button', { name: 'Run pattern' }) as HTMLButtonElement).disabled).toBe(true);
    selectAccount(kit.state, 'acc-2');
    await settle();
    await userEvent.click(area.getByRole('button', { name: 'Run pattern' }));
    await settle();
    expect(runOf(savedCalls(kit))[0]?.args[1]).toEqual({ anchor: { entityType: 'kind-a', stableId: 'acc-2' } });
  });

  it('carries the masking flag of the investigation', async () => {
    const kit = await savedWorkspace({ patterns: { listPatterns: async () => page([listed({ id: ID, name: 'Alpha' })]), runSavedPattern: async () => ({ ok: true, value: definitionOk(['acc-2']) }) } });
    act(() => kit.state.setMask(true));
    await settle();
    await openTab(/My patterns/);
    await press('Run Alpha');
    expect(runOf(savedCalls(kit))[0]?.args[1]).toEqual({ mask: true });
  });

  it('shows the heavy banner and continues with the page the server offered', async () => {
    const kit = await savedWorkspace({ patterns: { listPatterns: async () => page([listed({ id: ID, name: 'Alpha' })]), runSavedPattern: async (_id, request) => ({ ok: true, value: (request.continue === true ? definitionOk(['acc-2']) : definitionHeavy()) }) } });
    await openTab(/My patterns/);
    await press('Run Alpha');
    expect(screen.getByRole('alert').textContent).toContain('warning threshold 500');
    await press('Continue with 25');
    expect(runOf(savedCalls(kit))[1]?.args[1]).toEqual({ continue: true, limit: 25 });
    expect(within(result()).getByRole('button', { name: 'Add to graph' })).toBeTruthy();
  });

  it('aborts a run that is cancelled, shows it as cancelled, and adds nothing', async () => {
    let signal: AbortSignal | undefined;
    await savedWorkspace({
      patterns: {
        listPatterns: async () => page([listed({ id: ID, name: 'Alpha' })]),
        runSavedPattern: (_id, _request, _key, given) => {
          signal = given;
          return new Promise(() => undefined);
        },
      },
    });
    await openTab(/My patterns/);
    await press('Run Alpha');
    await press('Cancel');
    expect(signal?.aborted).toBe(true);
    expect(screen.getByText('Cancelled. No new matches shown.')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Result' })).toBeNull();
  });

  it('says a failure in words and keeps the list and an earlier result on screen', async () => {
    let calls = 0;
    await savedWorkspace({ patterns: { listPatterns: async () => page([listed({ id: ID, name: 'Alpha' })]), runSavedPattern: async () => (++calls === 1 ? { ok: true, value: definitionOk(['acc-2']) } : { ok: false, failure: failure('SOURCE_BUSY') }) } });
    await openTab(/My patterns/);
    await press('Run Alpha');
    await press('Run Alpha');
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
    expect(within(screen.getByRole('tabpanel', { name: /My patterns/ })).getByText('Alpha')).toBeTruthy();
    expect(result()).toBeTruthy();
  });

  it('runs another person’s shared pattern with the same request, under the person’s own session', async () => {
    const kit = await savedWorkspace({ patterns: { listPatterns: async () => page([listed({ id: ID, name: 'Beta', ownedByYou: false, visibility: 'shared', owner: { name: 'Pat' } })]), runSavedPattern: async () => ({ ok: true, value: definitionOk(['acc-2']) }) } });
    await openTab(/Shared on this source/);
    await press('Run Beta');
    expect(runOf(savedCalls(kit))[0]?.args[1]).toEqual({});
  });
});

describe('running a saved run of a built-in pattern', () => {
  const preset = (): ListedPattern => listed({ id: ID, name: 'Devices', kind: 'preset-run', presetId: 'shared-devices', templateId: 'shared-attribute', templateVersion: 1, params: {} });

  it('shows the kind line with the built-in pattern’s name and answers as a preset answers', async () => {
    const kit = await savedWorkspace({ patterns: { listPatterns: async () => page([preset()]), runSavedPattern: async () => ({ ok: true, value: okRun(['acc-2']) }) } });
    await openTab(/My patterns/);
    expect(within(screen.getByRole('tabpanel', { name: /My patterns/ })).getByText('Shared devices')).toBeTruthy();
    await press('Run Devices');
    expect(runOf(savedCalls(kit))[0]?.args[1]).toEqual({});
    expect(within(result()).getByRole('button', { name: 'Add to graph' })).toBeTruthy();
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
  const gone = (): ListedPattern => listed({ id: ID, name: 'Alpha', availability: { status: 'unavailable', reasons: [{ code: 'unknown-property', path: ['steps', 1, 'conditions', 0] }] } });

  it('says it is unavailable with a sentence for the reason and the step, and disables Run with that reason', async () => {
    await savedWorkspace({ patterns: { listPatterns: async () => page([gone()]) } });
    await openTab(/My patterns/);
    const panel = within(screen.getByRole('tabpanel', { name: /My patterns/ }));
    expect(panel.getByText('Unavailable')).toBeTruthy();
    expect(panel.getByText(`${UNAVAILABLE_TEXT['unknown-property']} (step 2)`)).toBeTruthy();
    const run = panel.getByRole('button', { name: 'Run Alpha' }) as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    expect(run.getAttribute('aria-describedby')).toBeTruthy();
  });

  it('has a sentence in words for each of the reason codes, and none holds a code or a name', async () => {
    await savedWorkspace({ patterns: { listPatterns: async () => page([listed({ id: ID, name: 'Alpha', availability: { status: 'unavailable', reasons } })]) } });
    await openTab(/My patterns/);
    const panel = within(screen.getByRole('tabpanel', { name: /My patterns/ }));
    for (const code of PATTERN_UNAVAILABLE_CODES) {
      expect(panel.getByText(UNAVAILABLE_TEXT[code])).toBeTruthy();
      expect(UNAVAILABLE_TEXT[code]).not.toContain(code);
    }
  });

  it('shows a row the list called available as unavailable when the run route says so, and no result', async () => {
    await savedWorkspace({ patterns: { listPatterns: async () => page([listed({ id: ID, name: 'Alpha' })]), runSavedPattern: async () => ({ ok: true, value: { status: 'unavailable', reasons: [{ code: 'unknown-entity-type' }] } }) } });
    await openTab(/My patterns/);
    await press('Run Alpha');
    const area = within(screen.getByRole('region', { name: 'Run: Alpha' }));
    expect(area.getByText('Unavailable')).toBeTruthy();
    expect(area.getByText(UNAVAILABLE_TEXT['unknown-entity-type'])).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Result' })).toBeNull();
  });

  it('reads the list again after that answer, so that the row says it is unavailable', async () => {
    let reads = 0;
    await savedWorkspace({
      patterns: {
        listPatterns: async () => page([++reads === 1 ? listed({ id: ID, name: 'Alpha' }) : listed({ id: ID, name: 'Alpha', availability: { status: 'unavailable', reasons: [{ code: 'unknown-entity-type' }] } })]),
        runSavedPattern: async () => ({ ok: true, value: { status: 'unavailable', reasons: [{ code: 'unknown-entity-type' }] } }),
      },
    });
    await openTab(/My patterns/);
    await press('Run Alpha');
    expect((within(screen.getByRole('tabpanel', { name: /My patterns/ })).getByRole('button', { name: 'Run Alpha' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('what a run leaves in the list', () => {
  it('reads the list again after a result, so that the last run of the pattern is shown', async () => {
    let reads = 0;
    await savedWorkspace({
      patterns: {
        listPatterns: async () => page([listed({ id: ID, name: 'Alpha', lastRunAt: ++reads === 1 ? null : '2026-11-13T08:00:00.000Z' })]),
        runSavedPattern: async () => ({ ok: true, value: definitionOk(['acc-2']) }),
      },
    });
    await openTab(/My patterns/);
    expect(screen.getByText('Not run yet · Only me')).toBeTruthy();
    await press('Run Alpha');
    expect(screen.getByText('Last run 2026-11-13 UTC · Only me')).toBeTruthy();
  });

  it('says a pattern that is gone, and reads the list again so that its row goes, when the run answers NOT_FOUND', async () => {
    let reads = 0;
    const kit = await savedWorkspace({
      patterns: {
        listPatterns: async () => page(++reads === 1 ? [listed({ id: ID, name: 'Beta', ownedByYou: false, visibility: 'shared', owner: { name: 'Pat' } })] : []),
        runSavedPattern: async () => ({ ok: false, failure: failure('NOT_FOUND') }),
      },
    });
    await openTab(/Shared on this source/);
    await press('Run Beta');
    expect(kit.patternCalls.filter((call) => call.method === 'listPatterns')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Run Beta' })).toBeNull();
  });

  it('shows the run of a pattern of the person’s own under My patterns only, not under Shared on this source', async () => {
    await savedWorkspace({ patterns: { listPatterns: async () => page([listed({ id: ID, name: 'Alpha' })]), runSavedPattern: async () => ({ ok: true, value: definitionOk(['acc-2']) }) } });
    await openTab(/My patterns/);
    await press('Run Alpha');
    expect(screen.getByRole('region', { name: 'Run: Alpha' })).toBeTruthy();
    await openTab(/Shared on this source/);
    expect(screen.queryByRole('region', { name: 'Run: Alpha' })).toBeNull();
  });
});
