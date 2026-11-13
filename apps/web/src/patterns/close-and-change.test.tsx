import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ListedPattern, PatternListResponse } from '@neburyx/contracts';
import type { ApiResult } from '../api/client.js';
import { afterDebounce, conditionsProfile, previewed, previewedSaved, runWorkspace } from './run/run-kit.js';
import { listed, openPatterns, patternsWorkspace, settle } from './patterns-kit.js';

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.useRealTimers();
});

const ID = '0192f000-0000-7000-8000-000000000001';
const DEFINITION = { anchorType: 'c-a', steps: [{ relationshipTypes: ['k-1'], direction: 'out', arrivesAt: 'c-b', conditions: [], window: { days: 30 } }] };
const page = (items: readonly ListedPattern[]): ApiResult<PatternListResponse> => ({ ok: true, value: { items: [...items], nextCursor: null } });
const subhead = (): string => document.querySelector('.patterns-subhead')?.textContent ?? '';
const closeX = (): HTMLElement => screen.getByRole('button', { name: /^Close Patterns$/ });

describe('the heading of a change', () => {
  const change = async (): Promise<void> => {
    await patternsWorkspace({ profile: async () => ({ ok: true, value: conditionsProfile() }), patterns: { listPatterns: async () => page([listed({ id: ID, name: 'Alpha', definition: DEFINITION, version: 4 })]) } });
    await openPatterns();
    await userEvent.click(screen.getByRole('button', { name: 'More: Alpha' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Change' }));
    await settle();
  };

  it('names the saved pattern under the heading, not a draft, and says "Changes not saved" once the pattern is edited', async () => {
    await change();
    expect(subhead()).toBe('Alpha');
    await userEvent.click(screen.getByRole('tab', { name: 'Step 1' }));
    await userEvent.click(screen.getByRole('radio', { name: 'Incoming' }));
    await settle();
    expect(subhead()).toBe('Alpha · Changes not saved');
    expect(document.body.textContent).not.toContain('Draft · not saved');
  });
});

describe('the X of the preview', () => {
  it('asks before closing when a draft would be lost, and keeps the draft on Keep editing', async () => {
    await runWorkspace();
    await previewed();
    await userEvent.click(closeX());
    expect(screen.getByRole('dialog').textContent).toContain('The pattern you have built is not saved.');
    await userEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Preview pattern' })).toBeTruthy();
  });

  it('asks on Escape too, since Escape closes the panel', async () => {
    await runWorkspace();
    await previewed();
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('dialog').textContent).toContain('The pattern you have built is not saved.');
  });

  it('closes the panel on Discard draft', async () => {
    await runWorkspace();
    await previewed();
    await userEvent.click(closeX());
    await userEvent.click(screen.getByRole('button', { name: 'Discard draft' }));
    await settle();
    expect(screen.queryByRole('heading', { name: 'Preview pattern' })).toBeNull();
  });

  it('closes at once for a change that was not edited, since nothing is lost', async () => {
    await previewedSaved();
    await userEvent.click(closeX());
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Preview pattern' })).toBeNull();
  });
});

describe('the X of the preview of an edited change', () => {
  it('asks, in the words of changes, and shows "Changes not saved" under the heading of the preview', async () => {
    const item = listed({ id: ID, name: 'Alpha', definition: DEFINITION, version: 4 });
    await patternsWorkspace({ profile: async () => ({ ok: true, value: conditionsProfile() }), patterns: { listPatterns: async () => page([item]) } });
    await openPatterns();
    await userEvent.click(screen.getByRole('button', { name: 'More: Alpha' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Change' }));
    await settle();
    await userEvent.click(screen.getByRole('tab', { name: 'Step 1' }));
    await userEvent.click(screen.getByRole('radio', { name: 'Either' }));
    await settle();
    await afterDebounce();
    await userEvent.click(screen.getByRole('button', { name: /^Preview/ }));
    await settle();
    expect(screen.getByRole('heading', { name: 'Preview pattern' })).toBeTruthy();
    expect(subhead()).toBe('Alpha · Changes not saved');
    await userEvent.click(closeX());
    expect(screen.getByRole('dialog').textContent).toContain('The changes you have made to this pattern are not saved.');
    expect(screen.getByRole('button', { name: 'Discard changes' })).toBeTruthy();
  });
});

describe('the X and Escape of the builder of a change', () => {
  const change = async (): Promise<void> => {
    await patternsWorkspace({ profile: async () => ({ ok: true, value: conditionsProfile() }), patterns: { listPatterns: async () => page([listed({ id: ID, name: 'Alpha', definition: DEFINITION, version: 4 })]) } });
    await openPatterns();
    await userEvent.click(screen.getByRole('button', { name: 'More: Alpha' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Change' }));
    await settle();
  };

  it('closes at once while the pattern is as it was opened', async () => {
    await change();
    await userEvent.click(screen.getByRole('button', { name: 'Close pattern builder' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Change pattern: Alpha' })).toBeNull();
  });

  it('asks, in the words of changes, once it is edited, on the close button and on Escape', async () => {
    await change();
    await userEvent.click(screen.getByRole('tab', { name: 'Step 1' }));
    await userEvent.click(screen.getByRole('radio', { name: 'Either' }));
    await userEvent.click(screen.getByRole('button', { name: 'Close pattern builder' }));
    expect(screen.getByRole('dialog').textContent).toContain('The changes you have made to this pattern are not saved.');
    await userEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Either' }), { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'Discard changes' })).toBeTruthy();
  });
});
