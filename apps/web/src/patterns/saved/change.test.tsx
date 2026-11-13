import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { savedPatternSchema, type ListedPattern, type PatternListResponse, type SavedPattern } from '@neburyx/contracts';
import type { ApiResult } from '../../api/client.js';
import { conditionsProfile } from '../run/run-kit.js';
import { failure, listed, openPatterns, patternsWorkspace, settle, type KitOptions } from '../patterns-kit.js';
import { UNAVAILABLE_TEXT } from './saved-copy.js';

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.useRealTimers();
});

const ID = '0192f000-0000-7000-8000-000000000001';
const DEFINITION = {
  anchorType: 'c-a',
  steps: [
    {
      relationshipTypes: ['k-1'],
      direction: 'out',
      arrivesAt: 'c-b',
      conditions: [
        { on: 'neighbor', property: 'b-name', op: 'eq', value: { kind: 'text', value: 'abc' } },
        { on: 'relationship', property: 'q-when', op: 'between', from: { kind: 'date', value: '2026-01-01' } },
      ],
      window: { days: 30 },
    },
  ],
};
const page = (items: readonly ListedPattern[]): ApiResult<PatternListResponse> => ({ ok: true, value: { items: [...items], nextCursor: null } });
const stored = (overrides: Partial<SavedPattern> = {}): SavedPattern => savedPatternSchema.parse({ id: ID, sourceId: 'a', name: 'Alpha', askForStartingEntity: true, anchor: null, visibility: 'private', lastRunAt: null, createdAt: '2026-11-12T10:00:00.000Z', updatedAt: '2026-11-12T10:00:00.000Z', version: 4, kind: 'definition', definition: {}, ...overrides });

async function opened(item: ListedPattern, options: KitOptions = {}) {
  const kit = await patternsWorkspace({ profile: async () => ({ ok: true, value: conditionsProfile() }), ...options, patterns: { listPatterns: async () => page([item]), ...options.patterns } });
  await openPatterns();
  await userEvent.click(screen.getByRole('button', { name: `More: ${item.name}` }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Change' }));
  await settle();
  return kit;
}
const builder = () => within(screen.getByRole('region', { name: 'Change pattern: Alpha' }));
/** The preview of the pattern opened for a change, where Save changes… and Save as new… are. */
const toPreview = async (): Promise<void> => {
  await userEvent.click(screen.getByRole('button', { name: /^Preview/ }));
  await settle();
};
const calls = (kit: Awaited<ReturnType<typeof opened>>, method: string) => kit.patternCalls.filter((call) => call.method === method);

describe('changing a saved pattern in the builder', () => {
  it('opens the builder with the start type, the step, the conditions and the window as stored', async () => {
    await opened(listed({ id: ID, name: 'Alpha', definition: DEFINITION, version: 4 }));
    expect((builder().getByLabelText('Starting entity type') as HTMLSelectElement).value).toBe('c-a');
    await userEvent.click(builder().getByRole('tab', { name: 'Step 1' }));
    const step = within(builder().getByRole('tabpanel', { name: 'Step 1' }));
    expect(step.getByRole('radio', { name: 'Outgoing' }).getAttribute('aria-checked')).toBe('true');
    expect((step.getByLabelText('Arrives at') as HTMLSelectElement).value).toBe('c-b');
    expect(step.getByRole('button', { name: 'Remove k-1' })).toBeTruthy();
    await userEvent.click(step.getByRole('tab', { name: /^Conditions/ }));
    expect(step.getByText('b-name is abc')).toBeTruthy();
    expect(step.getByText('q-when is 2026-01-01 or more')).toBeTruthy();
    await userEvent.click(step.getByRole('tab', { name: /^Window/ }));
    expect((step.getByLabelText('Step 1 window: Days') as HTMLInputElement).value).toBe('30');
    expect(screen.getByText('Changing a saved pattern. Save changes keeps it where it is; Save as new makes another.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Change pattern: Alpha' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'New pattern' })).toBeNull();
  });

  it('saves a private pattern at once with the definition and the version alone, leaves the starting entity while the start type and the choice are as stored, and returns to the list', async () => {
    const kit = await opened(listed({ id: ID, name: 'Alpha', definition: DEFINITION, version: 4, askForStartingEntity: true, anchor: null }), { patterns: { changePattern: async () => ({ ok: true, value: stored() }) } });
    await vi.advanceTimersByTimeAsync(400);
    await settle();
    await toPreview();
    await userEvent.click(screen.getByRole('button', { name: 'Save changes…' }));
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    const [call] = calls(kit, 'changePattern');
    expect(call?.args[0]).toBe(ID);
    expect(call?.args[1]).toMatchObject({ expectedVersion: 4, definition: { anchorType: 'c-a', steps: [{ relationshipTypes: ['k-1'], window: { days: 30 } }] } });
    expect(Object.keys(call?.args[1] as object).sort()).toEqual(['definition', 'expectedVersion']);
    expect(screen.getByText('Pattern saved.')).toBeTruthy();
    expect(screen.queryByRole('region', { name: /^Change pattern/ })).toBeNull();
  });

  it('keeps the starting entity a pattern holds when it is not loaded or another is selected', async () => {
    const held = listed({ id: ID, name: 'Alpha', definition: DEFINITION, version: 4, askForStartingEntity: false, anchor: { entityType: 'c-a', stableId: 'old' } });
    const kit = await opened(held, { nodes: [], opened: null, patterns: { changePattern: async () => ({ ok: true, value: stored() }) } });
    await vi.advanceTimersByTimeAsync(400);
    await settle();
    await toPreview();
    await userEvent.click(screen.getByRole('button', { name: 'Save changes…' }));
    await settle();
    expect(calls(kit, 'changePattern')[0]?.args[1]).not.toHaveProperty('anchor');
  });

  it('says the pattern changed on a stale version, keeps the edits and the dialog, and Save as a copy makes a new private pattern with the edited definition', async () => {
    const kit = await opened(listed({ id: ID, name: 'Alpha', definition: DEFINITION, version: 4 }), { patterns: { changePattern: async () => ({ ok: false, failure: failure('CONFLICT') }), savePattern: async () => ({ ok: true, value: stored({ id: '0192f000-0000-7000-8000-0000000000b2', version: 1 }) }) } });
    await vi.advanceTimersByTimeAsync(400);
    await settle();
    await toPreview();
    await userEvent.click(screen.getByRole('button', { name: 'Save changes…' }));
    await settle();
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByRole('alert').textContent).toBe('This pattern was changed by someone else after you opened it. Your edits are kept. You can save them as a copy.');
    expect(dialog.queryByRole('button', { name: 'Save for everyone' })).toBeNull();
    expect(calls(kit, 'listPatterns').length).toBeGreaterThanOrEqual(2);
    await userEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
    await userEvent.click(screen.getByRole('button', { name: /Edit$/ }));
    await userEvent.click(builder().getByRole('tab', { name: 'Step 1' }));
    await userEvent.click(builder().getByRole('tab', { name: /^Conditions/ }));
    expect(builder().getByText('b-name is abc')).toBeTruthy();
    await toPreview();
    await userEvent.click(screen.getByRole('button', { name: 'Save changes…' }));
    await settle();
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save as a copy' }));
    await settle();
    expect(calls(kit, 'savePattern')).toHaveLength(1);
    expect(calls(kit, 'savePattern')[0]?.args[0]).toMatchObject({ sourceId: 'a', kind: 'definition', name: 'Alpha (copy)', definition: { anchorType: 'c-a' } });
    expect(screen.getByText('Saved as a copy.')).toBeTruthy();
  });

  it('can save the edits as a new pattern from Save as new…, with the dialog of a new pattern', async () => {
    const kit = await opened(listed({ id: ID, name: 'Alpha', definition: DEFINITION, version: 4 }), { patterns: { savePattern: async () => ({ ok: true, value: stored({ id: '0192f000-0000-7000-8000-0000000000b2', version: 1 }) }) } });
    await vi.advanceTimersByTimeAsync(400);
    await settle();
    await toPreview();
    await userEvent.click(screen.getByRole('button', { name: 'Save as new…' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' }));
    await settle();
    expect(calls(kit, 'savePattern')).toHaveLength(1);
  });

  it('opens a definition the mapping no longer supports with the parts it cannot place said in words, and keeps Preview off, so nothing can be saved', async () => {
    const gone = { anchorType: 'c-a', steps: [{ relationshipTypes: ['k-gone'], direction: 'out', arrivesAt: 'c-gone' }] };
    await opened(listed({ id: ID, name: 'Alpha', definition: gone, availability: { status: 'unavailable', reasons: [{ code: 'unknown-entity-type', path: ['steps', 0, 'arrivesAt'] }] } }), { validate: async () => ({ ok: true, value: { status: 'invalid', problems: [{ path: ['steps', 0, 'arrivesAt'], code: 'unknown-entity-type' }] } }) });
    await vi.advanceTimersByTimeAsync(400);
    await settle();
    await userEvent.click(builder().getByRole('tab', { name: /^Step 1/ }));
    expect(within(builder().getByRole('tabpanel', { name: /^Step 1/ })).getByText(UNAVAILABLE_TEXT['unknown-entity-type'])).toBeTruthy();
    expect((screen.getByRole('button', { name: /^Preview/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save changes…' })).toBeNull();
  });

  it('opens empty, saying so, for a stored definition that no longer passes the schema', async () => {
    await opened(listed({ id: ID, name: 'Alpha', definition: { anchorType: 'c-a', steps: [] }, availability: { status: 'unavailable', reasons: [{ code: 'bad-definition' }] } }));
    expect(builder().getByText('This part of the pattern cannot be shown because the mapping no longer has it.')).toBeTruthy();
    expect((builder().getByLabelText('Starting entity type') as HTMLSelectElement).value).toBe('');
  });

  it('offers Change only on the person’s own built patterns, not on a saved built-in run or another person’s shared one', async () => {
    const kit = await patternsWorkspace({ patterns: { listPatterns: async () => page([listed({ id: ID, name: 'Alpha', kind: 'preset-run', presetId: 'shared-devices', templateId: 'shared-attribute', templateVersion: 1, params: {} }), listed({ id: '0192f000-0000-7000-8000-000000000002', name: 'Beta', ownedByYou: false, visibility: 'shared', owner: { name: 'Pat' } })]) } });
    void kit;
    await openPatterns();
    await userEvent.click(screen.getByRole('button', { name: 'More: Alpha' }));
    expect(within(screen.getByRole('menu')).queryByRole('menuitem', { name: 'Change' })).toBeNull();
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('button', { name: 'More: Beta' }));
    expect(within(screen.getByRole('menu')).queryByRole('menuitem', { name: 'Change' })).toBeNull();
  });
});

describe('changing a pattern others run', () => {
  const shared = (): ListedPattern => listed({ id: ID, name: 'Alpha', definition: DEFINITION, version: 4, visibility: 'shared' });
  const toDialog = async (options: KitOptions = {}) => {
    const kit = await opened(shared(), options);
    await vi.advanceTimersByTimeAsync(400);
    await settle();
    await toPreview();
    await userEvent.click(screen.getByRole('button', { name: 'Save changes…' }));
    await settle();
    return kit;
  };
  const dialog = () => within(screen.getByRole('dialog'));

  it('asks first, in the words of PB18, and sends nothing until a choice is made; Cancel gives the focus back to Save changes…', async () => {
    const kit = await toDialog();
    expect(dialog().getByRole('heading', { name: 'Save changes to “Alpha”?' })).toBeTruthy();
    expect(dialog().getByText('Others on this source run this pattern. Save for everyone?')).toBeTruthy();
    expect(calls(kit, 'changePattern')).toHaveLength(0);
    await userEvent.click(dialog().getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls(kit, 'changePattern')).toHaveLength(0);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Save changes…' }));
  });

  it('saves for everyone with the definition and the version, and returns to the list', async () => {
    const kit = await toDialog({ patterns: { changePattern: async () => ({ ok: true, value: stored({ visibility: 'shared' }) }) } });
    await userEvent.click(dialog().getByRole('button', { name: 'Save for everyone' }));
    await settle();
    expect(calls(kit, 'changePattern')[0]?.args.slice(0, 2)).toEqual([ID, expect.objectContaining({ expectedVersion: 4, definition: expect.objectContaining({ anchorType: 'c-a' }) })]);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Pattern saved.')).toBeTruthy();
  });

  it('saves as a copy with the next name when the first is used, and sends no change to the shared pattern', async () => {
    let tries = 0;
    const kit = await toDialog({ patterns: { savePattern: async () => (++tries === 1 ? { ok: false, failure: failure('CONFLICT', { reason: 'pattern-name-taken' }) } : { ok: true, value: stored({ name: 'Alpha (copy 2)' }) }) } });
    await userEvent.click(dialog().getByRole('button', { name: 'Save as a copy' }));
    await settle();
    expect(calls(kit, 'savePattern').map((call) => (call.args[0] as { name: string }).name)).toEqual(['Alpha (copy)', 'Alpha (copy 2)']);
    expect(calls(kit, 'changePattern')).toHaveLength(0);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps the dialog open on a stale version, says the pattern changed and leaves Save as a copy possible', async () => {
    await toDialog({ patterns: { changePattern: async () => ({ ok: false, failure: failure('CONFLICT') }) } });
    await userEvent.click(dialog().getByRole('button', { name: 'Save for everyone' }));
    await settle();
    expect(dialog().getByRole('alert').textContent).toMatch(/changed by someone else/);
    expect((dialog().getByRole('button', { name: 'Save as a copy' }) as HTMLButtonElement).disabled).toBe(false);
    expect(dialog().queryByRole('button', { name: 'Save for everyone' })).toBeNull();
    expect(dialog().getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });

  it('keeps the focus inside the dialog', async () => {
    await toDialog();
    for (let press = 0; press < 8; press += 1) {
      await userEvent.tab();
      expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
    }
  });
});
