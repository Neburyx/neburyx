import { act, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createClientState } from '../state/client-state.js';
import type { InvestigationRecord } from '../state/investigation-state.js';
import { clientWith, me, renderApp, source } from '../test-utils.js';

const client = clientWith({ me: me(), sources: [source('a')] });

function stateWith(record: InvestigationRecord | null) {
  const state = createClientState();
  state.bindSource('a');
  state.describeInvestigation(record);
  return state;
}

const saved: InvestigationRecord = { title: 'Suspicious linked accounts', caseRef: 'REF-2026-1048', status: 'open' as const, readOnly: false, version: 1, save: { kind: 'saved', at: '2026-10-28T09:42:00Z' } };
const header = () => screen.getByRole('banner', { name: 'Investigation' });

describe('the investigation identity in the header', () => {
  it('reads the breadcrumb, the title, the case reference and "Saved 09:42 UTC" for a saved investigation', () => {
    renderApp('/explore', client, stateWith(saved));
    const bar = within(header());
    const crumb = bar.getByRole('link', { name: 'Investigations' });
    expect(crumb.getAttribute('href')).toBe('/investigations');
    expect(crumb.parentElement?.textContent).toBe('Investigations /');
    expect(bar.getByRole('heading', { level: 1, name: 'Suspicious linked accounts' })).toBeTruthy();
    expect(bar.getByText('REF-2026-1048')).toBeTruthy();
    expect(bar.getByRole('status').textContent).toBe('Saved 09:42 UTC');
  });

  it('puts the pieces in that order', () => {
    renderApp('/explore', client, stateWith(saved));
    const order = [...(screen.getByRole('heading', { level: 1 }).parentElement?.children ?? [])].map((element) => element.textContent);
    expect(order).toEqual(['Investigations /', 'Suspicious linked accounts', 'REF-2026-1048', 'Saved 09:42 UTC']);
  });

  it('reads "Unsaved" for an unsaved investigation', () => {
    renderApp('/explore', client, stateWith({ ...saved, save: { kind: 'unsaved' } }));
    expect(within(header()).getByRole('status').textContent).toBe('Unsaved');
  });

  it('shows only the breadcrumb when no investigation record is held', () => {
    renderApp('/explore', client, stateWith(null));
    const bar = within(header());
    expect(bar.getByRole('link', { name: 'Investigations' })).toBeTruthy();
    expect(bar.queryByRole('heading')).toBeNull();
    expect(bar.queryByRole('status')).toBeNull();
  });

  it('shows no reference for a record without a case reference', () => {
    renderApp('/explore', client, stateWith({ ...saved, caseRef: null }));
    expect(screen.queryByText(/REF-/)).toBeNull();
    expect(within(header()).getByRole('status').textContent).toBe('Saved 09:42 UTC');
  });

  it('keeps a title of 200 characters whole as its accessible name, for the layout to cut with an ellipsis', () => {
    const title = 'T'.repeat(200);
    renderApp('/explore', client, stateWith({ ...saved, title }));
    expect(within(header()).getByRole('heading', { level: 1, name: title })).toBeTruthy();
  });

  it('shows the investigation menu stand-in after the pill, and not without a record', () => {
    const { slots } = renderApp('/explore', client, stateWith(saved));
    act(() => {
      slots.register('investigation-menu', () => <button type="button">Menu</button>);
    });
    const pill = within(header()).getByRole('status');
    expect(pill.nextElementSibling?.textContent).toBe('Menu');
    const without = renderApp('/explore', client, stateWith(null));
    act(() => {
      without.slots.register('investigation-menu', () => <button type="button">Menu</button>);
    });
    expect(screen.getAllByRole('button', { name: 'Menu' })).toHaveLength(1);
  });

  it('updates when the record changes, and keeps the header when it is cleared', () => {
    const state = stateWith(saved);
    renderApp('/explore', client, state);
    act(() => state.describeInvestigation({ ...saved, save: { kind: 'unsaved' } }));
    expect(within(header()).getByRole('status').textContent).toBe('Unsaved');
    act(() => state.describeInvestigation(null));
    expect(within(header()).queryByRole('status')).toBeNull();
    expect(within(header()).getByRole('link', { name: 'Investigations' })).toBeTruthy();
  });
});
