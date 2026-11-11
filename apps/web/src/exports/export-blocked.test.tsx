import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderExport, shownState } from './harness.js';

const NOTE = 'Not available while the source has changed.';

function withSource(sourceState: 'available' | 'repointed' | 'removed', status: 'open' | 'closed' = 'open') {
  const state = shownState(status);
  const record = state.investigation.getState().record;
  if (record === null) throw new Error('no record');
  state.describeInvestigation({ ...record, sourceState });
  return state;
}

describe('the Export button when the source changed', () => {
  it.each(['repointed', 'removed'] as const)('is dimmed with its reason, and opens no dialog (%s)', async (sourceState) => {
    const createExport = vi.fn();
    renderExport(withSource(sourceState), { createExport });
    const button = screen.getByRole('button', { name: 'Export' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe(NOTE);
    expect(button.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.getElementById(button.getAttribute('aria-describedby') ?? '')?.textContent).toBe(NOTE);
    await userEvent.setup().click(button);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(createExport).not.toHaveBeenCalled();
  });

  it('stays available when the source is as it was, also for a closed investigation', () => {
    renderExport(withSource('available', 'closed'));
    const button = screen.getByRole('button', { name: 'Export' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.title).toBe('');
    expect(button.getAttribute('aria-describedby')).toBeNull();
  });

  it('is dimmed when the source changes while the page is open, and closes an open dialog', async () => {
    const state = withSource('available');
    renderExport(state);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Export' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    const record = state.investigation.getState().record;
    if (record === null) throw new Error('no record');
    act(() => state.describeInvestigation({ ...record, sourceState: 'repointed' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect((screen.getByRole('button', { name: 'Export' }) as HTMLButtonElement).disabled).toBe(true);
    act(() => state.describeInvestigation({ ...record, sourceState: 'available' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect((screen.getByRole('button', { name: 'Export' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('takes no focus when the investigation is already blocked on render and no dialog was open', () => {
    const heading = document.createElement('h1');
    document.body.append(heading);
    renderExport(withSource('repointed'));
    expect(document.activeElement).not.toBe(heading);
    expect(heading.hasAttribute('tabindex')).toBe(false);
    heading.remove();
  });

  it('hands the focus to the page heading when an open dialog is closed by the change', async () => {
    const state = withSource('available');
    renderExport(state);
    const heading = document.createElement('h1');
    document.body.append(heading);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Export' }));
    const record = state.investigation.getState().record;
    if (record === null) throw new Error('no record');
    act(() => state.describeInvestigation({ ...record, sourceState: 'removed' }));
    expect(document.activeElement).toBe(heading);
    heading.remove();
  });
});
