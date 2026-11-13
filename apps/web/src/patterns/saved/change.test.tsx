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
  await userEvent.click(screen.getByRole('tab', { name: /My patterns/ }));
  await userEvent.click(screen.getByRole('button', { name: `More: ${item.name}` }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Change' }));
  await settle();
  return kit;
}
const builder = () => within(screen.getByRole('region', { name: 'Change pattern: Alpha' }));
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

  it('saves the changes with the definition, the name and the version, leaves the starting entity alone while the start type and the choice are as stored, and returns to the list', async () => {
    const kit = await opened(listed({ id: ID, name: 'Alpha', definition: DEFINITION, version: 4, askForStartingEntity: true, anchor: null }), { patterns: { changePattern: async () => ({ ok: true, value: stored() }) } });
    await vi.advanceTimersByTimeAsync(400);
    await settle();
    await userEvent.click(builder().getByRole('button', { name: 'Save changes' }));
    expect((within(screen.getByRole('dialog')).getByLabelText('Name') as HTMLInputElement).value).toBe('Alpha');
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save changes' }));
    await settle();
    const [call] = calls(kit, 'changePattern');
    expect(call?.args[0]).toBe(ID);
    expect(call?.args[1]).toMatchObject({ expectedVersion: 4, name: 'Alpha', definition: { anchorType: 'c-a', steps: [{ relationshipTypes: ['k-1'], window: { days: 30 } }] } });
    expect(call?.args[1]).not.toHaveProperty('anchor');
    expect(screen.getByText('Pattern saved.')).toBeTruthy();
    expect(screen.queryByRole('region', { name: /pattern/i })).toBeNull();
  });

  it('keeps the starting entity a pattern holds when it is not loaded or another is selected, and clears it only when the person chooses to ask each time', async () => {
    const held = listed({ id: ID, name: 'Alpha', definition: DEFINITION, version: 4, askForStartingEntity: false, anchor: { entityType: 'c-a', stableId: 'old' } });
    const kit = await opened(held, { nodes: [], opened: null, patterns: { changePattern: async () => ({ ok: true, value: stored() }) } });
    await vi.advanceTimersByTimeAsync(400);
    await settle();
    await userEvent.click(builder().getByRole('button', { name: 'Save changes' }));
    const box = within(screen.getByRole('dialog')).getByRole('checkbox', { name: 'Ask for the starting entity each time' }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(box.disabled).toBe(false);
    expect(within(screen.getByRole('dialog')).getByText('The pattern keeps the starting entity it holds.')).toBeTruthy();
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save changes' }));
    await settle();
    expect(calls(kit, 'changePattern')[0]?.args[1]).not.toHaveProperty('anchor');
  });

  it('clears the held starting entity when the person chooses to ask each time', async () => {
    const held = listed({ id: ID, name: 'Alpha', definition: DEFINITION, version: 4, askForStartingEntity: false, anchor: { entityType: 'c-a', stableId: 'old' } });
    const kit = await opened(held, { patterns: { changePattern: async () => ({ ok: true, value: stored() }) } });
    await vi.advanceTimersByTimeAsync(400);
    await settle();
    await userEvent.click(builder().getByRole('button', { name: 'Save changes' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('checkbox', { name: 'Ask for the starting entity each time' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save changes' }));
    await settle();
    expect(calls(kit, 'changePattern')[0]?.args[1]).toMatchObject({ anchor: null });
  });

  it('keeps the edits and says the pattern changed on CONFLICT, and Save as new is still possible', async () => {
    const kit = await opened(listed({ id: ID, name: 'Alpha', definition: DEFINITION, version: 4 }), { patterns: { changePattern: async () => ({ ok: false, failure: failure('CONFLICT') }), savePattern: async () => ({ ok: true, value: stored({ id: '0192f000-0000-7000-8000-0000000000b2', version: 1 }) }) } });
    await vi.advanceTimersByTimeAsync(400);
    await settle();
    await userEvent.click(builder().getByRole('button', { name: 'Save changes' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save changes' }));
    await settle();
    expect(within(screen.getByRole('dialog')).getByRole('alert').textContent).toContain('The pattern changed since you read the list');
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await userEvent.click(builder().getByRole('tab', { name: 'Step 1' }));
    await userEvent.click(builder().getByRole('tab', { name: /^Conditions/ }));
    expect(builder().getByText('b-name is abc')).toBeTruthy();
    await userEvent.click(builder().getByRole('button', { name: 'Save as new' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save pattern' }));
    await settle();
    expect(calls(kit, 'savePattern')).toHaveLength(1);
  });

  it('opens a definition the mapping no longer supports with the parts it cannot place said in words, and keeps Save changes disabled', async () => {
    const gone = { anchorType: 'c-a', steps: [{ relationshipTypes: ['k-gone'], direction: 'out', arrivesAt: 'c-gone' }] };
    await opened(listed({ id: ID, name: 'Alpha', definition: gone, availability: { status: 'unavailable', reasons: [{ code: 'unknown-entity-type', path: ['steps', 0, 'arrivesAt'] }] } }), { validate: async () => ({ ok: true, value: { status: 'invalid', problems: [{ path: ['steps', 0, 'arrivesAt'], code: 'unknown-entity-type' }] } }) });
    await vi.advanceTimersByTimeAsync(400);
    await settle();
    await userEvent.click(builder().getByRole('tab', { name: /^Step 1/ }));
    expect(within(builder().getByRole('tabpanel', { name: /^Step 1/ })).getByText(UNAVAILABLE_TEXT['unknown-entity-type'])).toBeTruthy();
    expect((builder().getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(true);
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
    await userEvent.click(screen.getByRole('tab', { name: /My patterns/ }));
    await userEvent.click(screen.getByRole('button', { name: 'More: Alpha' }));
    expect(within(screen.getByRole('menu')).queryByRole('menuitem', { name: 'Change' })).toBeNull();
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('tab', { name: /Shared on this source/ }));
    await userEvent.click(screen.getByRole('button', { name: 'More: Beta' }));
    expect(within(screen.getByRole('menu')).queryByRole('menuitem', { name: 'Change' })).toBeNull();
  });
});
