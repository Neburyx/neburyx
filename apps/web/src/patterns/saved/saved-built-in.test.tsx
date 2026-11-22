import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { savedPatternSchema, type ListedPattern, type PatternListResponse, type SavedPattern } from '@neburyx/contracts';
import type { ApiResult } from '../../api/client.js';
import { failure, listOf, listed, okRun, openBuiltIn, patternsWorkspace, selectAccount, settle } from '../patterns-kit.js';
import { openTab, savedWorkspace } from './saved-list.test.js';
import { setMaskKeepingView } from '../../state/test-data.js';
import { UNAVAILABLE_TEXT } from './saved-copy.js';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const ID = '0192f000-0000-7000-8000-0000000000d1';
const PARAMS = { window: { from: '2026-10-21', to: '2026-10-28' }, limit: 25 };
const row = (over: Record<string, unknown> = {}): ListedPattern => listed({ id: ID, name: 'Devices week', kind: 'preset-run', presetId: 'shared-devices', templateId: 'shared-attribute', templateVersion: 1, params: PARAMS, ...over });
const page = (items: readonly ListedPattern[]): ApiResult<PatternListResponse> => ({ ok: true, value: { items: [...items], nextCursor: null } });
const stored = (over: Record<string, unknown> = {}): SavedPattern => savedPatternSchema.parse({ id: ID, sourceId: 'a', name: 'Devices week', askForStartingEntity: false, anchor: null, visibility: 'private', lastRunAt: null, createdAt: '2026-11-12T10:00:00.000Z', updatedAt: '2026-11-12T10:00:00.000Z', version: 1, kind: 'preset-run', presetId: 'shared-devices', templateId: 'shared-attribute', templateVersion: 1, params: PARAMS, ...over });
const calls = (kit: Awaited<ReturnType<typeof savedWorkspace>>, method: string) => kit.patternCalls.filter((call) => call.method === method);
const press = async (name: string): Promise<void> => {
  await userEvent.click(screen.getByRole('button', { name }));
  await settle();
};
const menuOf = (name: string): HTMLElement => screen.getByRole('button', { name: `More: ${name}` });
const choose = async (name: string): Promise<void> => {
  await userEvent.click(screen.getByRole('menuitem', { name }));
  await settle();
};
const items = (): string[] => within(screen.getByRole('menu')).getAllByRole('menuitem').map((entry) => entry.textContent ?? '');
const rowOf = (name: string): HTMLElement => {
  const item = mine().getByRole('heading', { name }).closest('li');
  if (item === null) throw new Error(`no row for ${name}`);
  return item;
};
const mine = () => within(screen.getByRole('region', { name: /My patterns/ }));
const answered = { listPatterns: async () => page([row()]), runSavedPattern: async () => ({ ok: true as const, value: okRun(['acc-2']) }) };

describe('a saved built-in run in the list', () => {
  it('shows the name, the built-in pattern with its template version, the chain, the parameters in words, "Not run yet" and the visibility, and no starting entity', async () => {
    await savedWorkspace({ patterns: { listPatterns: async () => page([row({ anchor: { entityType: 'kind-a', stableId: 'held-acc-9' } })]) } });
    await openTab(/My patterns/);
    const li = rowOf('Devices week');
    expect(li.textContent).toContain('Shared devices · v1');
    expect(li.textContent).toContain('Window (UTC) 21–28 Oct 2026, Max matching accounts 25');
    expect(li.textContent).toContain('Not run yet');
    expect(li.textContent).toContain('Private');
    expect(li.textContent).not.toContain('held-acc-9');
    await userEvent.click(menuOf('Devices week'));
    expect(document.body.textContent).not.toContain('held-acc-9');
  });
});

describe('running a saved built-in run', () => {
  it('sends no starting entity when the run holds its own, and shows the result the form shows for the same entity and parameters', async () => {
    const form = await patternsWorkspace({ run: async () => ({ ok: true, value: okRun(['acc-2']) }) });
    await openBuiltIn();
    selectAccount(form.state, 'acc-1');
    await press('Run pattern');
    const fromForm = document.querySelector('.patterns-result')?.textContent;
    expect(fromForm).toBeTruthy();
    cleanup();
    document.body.replaceChildren();
    const kit = await savedWorkspace({ patterns: answered });
    await press('Run Devices week');
    expect(calls(kit, 'runSavedPattern')[0]?.args[0]).toBe(ID);
    expect(calls(kit, 'runSavedPattern')[0]?.args[1]).toEqual({});
    expect(document.querySelector('.patterns-result')?.textContent).toBe(fromForm);
  });

  it('asks for the starting entity first when the run asks each time, and sends the one chosen as the anchor', async () => {
    const kit = await savedWorkspace({ opened: null, patterns: { listPatterns: async () => page([row({ askForStartingEntity: true, anchor: null })]), runSavedPattern: answered.runSavedPattern } });
    await press('Run Devices week');
    expect(calls(kit, 'runSavedPattern')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Run pattern' })).toHaveProperty('disabled', true);
    selectAccount(kit.state, 'acc-2');
    await settle();
    await press('Run pattern');
    expect(calls(kit, 'runSavedPattern')[0]?.args[1]).toEqual({ anchor: { entityType: 'kind-a', stableId: 'acc-2' } });
  });

  it('carries the masking flag of the investigation and shows the masked answer the route gives as the form shows it', async () => {
    const plain = okRun(['acc-2']);
    const masked = { ...plain, nodes: plain.status === 'ok' ? plain.nodes.map((node) => (node.ref.stableId === 'acc-1' ? node : { ...node, display: { ...node.display, title: '••••' } })) : [] };
    const form = await patternsWorkspace({ run: async () => ({ ok: true, value: masked }) });
    act(() => setMaskKeepingView(form.state, true));
    await settle();
    await openBuiltIn();
    selectAccount(form.state, 'acc-1');
    await press('Run pattern');
    expect(form.sent[0]?.request.mask).toBe(true);
    const fromForm = document.querySelector('.patterns-result')?.textContent;
    expect(fromForm).toContain('••••');
    expect(fromForm).not.toContain('dev-1');
    cleanup();
    document.body.replaceChildren();
    const kit = await savedWorkspace({ patterns: { listPatterns: answered.listPatterns, runSavedPattern: async () => ({ ok: true, value: masked }) } });
    act(() => kit.state.setMask(true));
    await settle();
    await press('Run Devices week');
    expect(calls(kit, 'runSavedPattern')[0]?.args[1]).toEqual({ mask: true });
    expect(document.querySelector('.patterns-result')?.textContent).toBe(fromForm);
  });

  it('says a refused run in words, keeps the run view and the list, and offers Try again', async () => {
    const kit = await savedWorkspace({ patterns: { listPatterns: answered.listPatterns, runSavedPattern: async () => ({ ok: false, failure: failure('QUERY_TIMEOUT') }) } });
    await press('Run Devices week');
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
    expect(screen.queryByRole('region', { name: 'Result' })).toBeNull();
    expect(calls(kit, 'listPatterns')).toHaveLength(1);
    await press('Back to patterns');
    expect(mine().getByRole('heading', { name: 'Devices week' })).toBeTruthy();
  });
});

describe('managing a saved built-in run', () => {
  it('renames with the stored parameters left alone, copies, shares, unshares and deletes after the confirmation', async () => {
    const kit = await savedWorkspace({
      patterns: {
        listPatterns: async () => page([row({ version: 3 }), row({ id: '0192f000-0000-7000-8000-0000000000d2', name: 'Open one', visibility: 'shared', version: 7 })]),
        changePattern: async () => ({ ok: true, value: stored() }),
        copyPattern: async () => ({ ok: true, value: stored({ id: '0192f000-0000-7000-8000-0000000000d3', name: 'Devices week (copy)' }) }),
        deletePattern: async () => ({ ok: true, value: { id: ID, version: 4, deletedAt: '2026-11-12T10:00:00.000Z', purgeAfter: '2026-12-12T10:00:00.000Z' } }),
      },
    });
    await userEvent.click(menuOf('Devices week'));
    expect(items()).toEqual(['Run', 'Rename', 'Share', 'Copy', 'Delete']);
    await choose('Rename');
    const field = screen.getByLabelText('Name');
    await userEvent.clear(field);
    await userEvent.type(field, 'Omega');
    await userEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await settle();
    expect(calls(kit, 'changePattern')[0]?.args.slice(0, 2)).toEqual([ID, { expectedVersion: 3, name: 'Omega' }]);
    await userEvent.click(menuOf('Devices week'));
    await choose('Copy');
    expect(calls(kit, 'copyPattern')[0]?.args[0]).toBe(ID);
    await userEvent.click(menuOf('Devices week'));
    await choose('Share');
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^Share/ }));
    await settle();
    expect(calls(kit, 'changePattern')[1]?.args.slice(0, 2)).toEqual([ID, { expectedVersion: 3, visibility: 'shared' }]);
    await userEvent.click(menuOf('Open one'));
    await choose('Unshare');
    expect(calls(kit, 'changePattern')[2]?.args.slice(0, 2)).toEqual(['0192f000-0000-7000-8000-0000000000d2', { expectedVersion: 7, visibility: 'private' }]);
    await userEvent.click(menuOf('Devices week'));
    await choose('Delete');
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete pattern' }));
    await settle();
    expect(calls(kit, 'deletePattern')[0]?.args.slice(0, 2)).toEqual([ID, 3]);
  });

  it('keeps the rename dialog and the typed name on a name already used', async () => {
    await savedWorkspace({ patterns: { listPatterns: answered.listPatterns, changePattern: async () => ({ ok: false, failure: failure('CONFLICT', { reason: 'pattern-name-taken' }) }) } });
    await userEvent.click(menuOf('Devices week'));
    await choose('Rename');
    const field = screen.getByLabelText('Name');
    await userEvent.clear(field);
    await userEvent.type(field, 'Beta');
    await userEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await settle();
    expect(field).toHaveProperty('value', 'Beta');
    expect(within(screen.getByRole('dialog')).getByRole('alert').textContent).toBe('This name is already used on this source. Choose another.');
  });

  it('says a stale delete in words, reads the list again and overwrites nothing', async () => {
    const kit = await savedWorkspace({ patterns: { listPatterns: answered.listPatterns, deletePattern: async () => ({ ok: false, failure: failure('CONFLICT') }) } });
    await userEvent.click(menuOf('Devices week'));
    await choose('Delete');
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete pattern' }));
    await settle();
    expect(screen.getByRole('alert').textContent).toMatch(/changed/);
    expect(calls(kit, 'listPatterns')).toHaveLength(2);
  });
});

describe('a saved built-in run that is not available', () => {
  const gone = (reasons: readonly { code: string }[]): ListedPattern => row({ availability: { status: 'unavailable', reasons } });

  it('carries the flag and the reason sentence, has Run off with the reason, and sends nothing for a press', async () => {
    const kit = await savedWorkspace({ patterns: { listPatterns: async () => page([gone([{ code: 'preset-removed' }])]) } });
    const li = rowOf('Devices week');
    expect(within(li).getByText('Unavailable')).toBeTruthy();
    expect(within(li).getByText(UNAVAILABLE_TEXT['preset-removed'])).toBeTruthy();
    const run = within(li).getByRole('button', { name: 'Run Devices week' });
    expect(run).toHaveProperty('disabled', true);
    await userEvent.click(run);
    expect(calls(kit, 'runSavedPattern')).toHaveLength(0);
  });

  it('runs and carries no flag when the template version changed compatibly', async () => {
    const newer = { ...listOf(), templates: listOf().templates.map((template) => ({ ...template, version: '2' })) };
    const kit = await savedWorkspace({ list: async () => ({ ok: true, value: newer }), patterns: { listPatterns: async () => page([row({ templateVersion: 1, availability: { status: 'available' } })]), runSavedPattern: answered.runSavedPattern } });
    expect(screen.queryByText('Unavailable')).toBeNull();
    await press('Run Devices week');
    expect(calls(kit, 'runSavedPattern')).toHaveLength(1);
    expect(screen.getByRole('region', { name: 'Result' })).toBeTruthy();
  });

  it('says the same in the run view and reads the list again when the run route answers unavailable for a row that was available', async () => {
    let reads = 0;
    const kit = await savedWorkspace({
      patterns: {
        listPatterns: async () => page([++reads === 1 ? row() : gone([{ code: 'preset-removed' }])]),
        runSavedPattern: async () => ({ ok: true, value: { status: 'unavailable', reasons: [{ code: 'preset-removed' }] } }),
      },
    });
    await press('Run Devices week');
    expect(screen.getAllByText(UNAVAILABLE_TEXT['preset-removed']).length).toBeGreaterThan(0);
    expect(screen.queryByRole('region', { name: 'Result' })).toBeNull();
    expect(calls(kit, 'listPatterns')).toHaveLength(2);
    await press('Back to patterns');
    expect(mine().getByRole('button', { name: 'Run Devices week' })).toHaveProperty('disabled', true);
  });

  it('keeps the menu of an available row for the same owner and visibility', async () => {
    await savedWorkspace({ patterns: { listPatterns: async () => page([gone([{ code: 'preset-removed' }])]) } });
    await userEvent.click(menuOf('Devices week'));
    expect(items()).toEqual(['Rename', 'Share', 'Copy', 'Delete']);
  });
});

describe('a saved built-in run whose built-in pattern is gone', () => {
  it('still shows the stored parameters in the preset-less words, with the flag and Run off', async () => {
    await savedWorkspace({ list: async () => ({ ok: true, value: listOf([]) }), patterns: { listPatterns: async () => page([row({ params: { limit: 25, minShared: 2 }, availability: { status: 'unavailable', reasons: [{ code: 'preset-removed' }] } })]) } });
    const li = rowOf('Devices week');
    expect(li.textContent).toContain('Limit 25, Min shared 2');
    expect(within(li).getByText('Unavailable')).toBeTruthy();
    expect(within(li).getByRole('button', { name: 'Run Devices week' })).toHaveProperty('disabled', true);
  });
});
