import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { listOf, okRun, openPatterns, patternsWorkspace, selectAccount, settle, CONNECTED, SHARED_DEVICES } from './patterns-kit.js';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const run = (): HTMLElement => screen.getByRole('button', { name: 'Run pattern' });

describe('the Patterns panel: open and run a preset', () => {
  it('lists exactly the presets of the source, first selected, with the intro line and no other card', async () => {
    await patternsWorkspace();
    await openPatterns();
    expect(screen.getByRole('heading', { name: 'Patterns' })).toBeTruthy();
    expect(screen.getByText('Approved ways to explore. No query language needed.')).toBeTruthy();
    const cards = within(screen.getByRole('radiogroup', { name: 'Patterns' })).getAllByRole('radio');
    expect(cards.map((card) => card.textContent)).toEqual(['Shared devices', 'Shared addresses', 'Connected accounts']);
    expect(cards.map((card) => card.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
    expect(screen.queryByText(/Suspicious/)).toBeNull();
  });

  it('sends one run with the source, the preset id, only the anchor ref, the mask and a fresh key', async () => {
    const kit = await patternsWorkspace();
    await openPatterns();
    selectAccount(kit.state, 'acc-1');
    await userEvent.click(run());
    await settle();
    expect(kit.sent).toHaveLength(1);
    const [sent] = kit.sent;
    expect(sent?.id).toBe(SHARED_DEVICES.id);
    expect(sent?.request).toEqual({ sourceId: 'a', params: { ref: { entityType: 'kind-a', stableId: 'acc-1' } } });
    expect(sent?.key).toMatch(/^[0-9a-f-]{36}$/);
    await userEvent.click(run());
    await settle();
    expect(kit.sent[1]?.key).not.toBe(sent?.key);
  });

  it('shows the match and what it shares as a table', async () => {
    const kit = await patternsWorkspace({ run: async () => ({ ok: true, value: okRun(['acc-2']) }) });
    await openPatterns();
    selectAccount(kit.state, 'acc-1');
    await userEvent.click(run());
    await settle();
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['KIND-A', 'Shared kind-b']);
    expect(within(table).getByText('acc-2')).toBeTruthy();
    expect(within(table).getByText('dev-1')).toBeTruthy();
  });

  it('disables Run until an entity of the anchor type is selected, and names the type', async () => {
    const kit = await patternsWorkspace();
    await openPatterns();
    expect(run().hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('Select a KIND-A to start.')).toBeTruthy();
    selectAccount(kit.state, 'acc-1');
    expect(run().hasAttribute('disabled')).toBe(false);
  });

  it('shows the source timeout beside Run, and no number when the source states none', async () => {
    await patternsWorkspace();
    await openPatterns();
    expect(screen.getByText('5 s timeout')).toBeTruthy();
    cleanup();
    document.body.replaceChildren();
    await patternsWorkspace({ timeoutMs: null });
    await openPatterns();
    expect(screen.queryByText(/timeout/)).toBeNull();
  });

  it('has no Save pattern control in any state', async () => {
    const kit = await patternsWorkspace();
    await openPatterns();
    selectAccount(kit.state, 'acc-1');
    expect(screen.queryByText(/Save pattern/)).toBeNull();
    await userEvent.click(run());
    await settle();
    expect(screen.queryByText(/Save pattern/)).toBeNull();
  });

  it('keeps the first preset and the list order the answer gives', async () => {
    await patternsWorkspace({ list: async () => ({ ok: true, value: listOf([CONNECTED, SHARED_DEVICES]) }) });
    await openPatterns();
    const cards = screen.getAllByRole('radio');
    expect(cards.map((card) => card.textContent)).toEqual(['Connected accounts', 'Shared devices']);
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Connected accounts' }), { key: 'ArrowDown' });
    await settle();
    expect(screen.getAllByRole('radio')[1]?.getAttribute('aria-checked')).toBe('true');
  });

  it('lists exactly the two presets of the insurance pack for a source that declares them', async () => {
    const claimant = { ...SHARED_DEVICES, id: 'shared-addresses', name: 'Shared addresses', bind: { anchor: 'kind-a', attribute: 'kind-c', via: 'LIVES_AT' }, labels: [{ key: 'anchor', text: 'Starting claimant' }] };
    const claims = { ...CONNECTED, id: 'claimant-claims', name: 'Claims by claimant', bind: { anchor: 'kind-a', target: 'kind-b', via: 'FILED_BY' }, labels: [{ key: 'anchor', text: 'Starting claimant' }] };
    await patternsWorkspace({ list: async () => ({ ok: true, value: listOf([claimant, claims]) }) });
    await openPatterns();
    expect(screen.getAllByRole('radio').map((card) => card.textContent)).toEqual(['Shared addresses', 'Claims by claimant']);
    expect(screen.getByLabelText('Starting claimant')).toBeTruthy();
  });
});
