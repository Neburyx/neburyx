import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { typedNode } from '../workspace/filters-kit.js';
import { choosePreset, listOf, okRun, openBuiltIn, openPatterns, patternsWorkspace, selectAccount, settle, CONNECTED, SHARED_DEVICES } from './patterns-kit.js';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const run = (): HTMLElement => screen.getByRole('button', { name: 'Run pattern' });

describe('the Patterns panel: open and run a preset', () => {
  it('lists exactly the presets of the source as rows with Run, with the intro line and no other card, and opens the form of the one chosen', async () => {
    await patternsWorkspace();
    await openPatterns();
    expect(screen.getByRole('heading', { level: 2, name: 'Patterns' })).toBeTruthy();
    expect(screen.getByText('Approved ways to explore. No query language needed.')).toBeTruthy();
    const rows = within(screen.getByRole('region', { name: /^Built-in/ })).getAllByRole('listitem');
    expect(rows.map((row) => row.querySelector('.pattern-row-name')?.textContent)).toEqual(['Shared devices', 'Shared addresses', 'Connected accounts']);
    expect(screen.queryByText(/Suspicious/)).toBeNull();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'Run Shared addresses' }));
    expect(screen.getByRole('heading', { level: 2, name: 'Shared addresses' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Back to patterns' }));
    expect(screen.getByRole('heading', { level: 2, name: 'Patterns' })).toBeTruthy();
  });

  it('sends one run with the source, the preset id, only the anchor ref, the mask and a fresh key', async () => {
    const kit = await patternsWorkspace();
    await openBuiltIn();
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
    await openBuiltIn();
    selectAccount(kit.state, 'acc-1');
    await userEvent.click(run());
    await settle();
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['KIND-A', 'Shared kind-b']);
    expect(within(table).getByText('acc-2')).toBeTruthy();
    expect(within(table).getByText('dev-1')).toBeTruthy();
  });

  it('disables Run until an entity of the anchor type is selected, and says which entity to choose, in the words of the field label', async () => {
    const kit = await patternsWorkspace({ nodes: [typedNode('dev-1', 'kind-b'), typedNode('acc-1', 'kind-a')], opened: { entityType: 'kind-b', stableId: 'dev-1' } });
    await openBuiltIn();
    expect(run().hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('Choose the starting account to run this pattern.')).toBeTruthy();
    selectAccount(kit.state, 'acc-1');
    expect(run().hasAttribute('disabled')).toBe(false);
  });

  it('takes the entity the investigation was opened on as the starting entity, so Run is enabled without a pick', async () => {
    const kit = await patternsWorkspace();
    await openBuiltIn();
    expect(run().hasAttribute('disabled')).toBe(false);
    expect((screen.getByLabelText('Starting account') as HTMLSelectElement).value).toContain('acc-1');
    await userEvent.click(run());
    await settle();
    expect(kit.sent[0]?.request.params).toEqual({ ref: { entityType: 'kind-a', stableId: 'acc-1' } });
  });

  it('does not take the first loaded entity of the type when it is not the one the investigation was opened on', async () => {
    await patternsWorkspace({ nodes: [typedNode('acc-1', 'kind-a'), typedNode('dev-1', 'kind-b')], opened: { entityType: 'kind-b', stableId: 'dev-1' } });
    await openBuiltIn();
    expect(run().hasAttribute('disabled')).toBe(true);
    expect((screen.getByLabelText('Starting account') as HTMLSelectElement).value).toBe('');
  });

  it('shows a result only under the pattern that produced it, and again when the person goes back to it', async () => {
    const kit = await patternsWorkspace();
    await openBuiltIn();
    selectAccount(kit.state, 'acc-1');
    await userEvent.click(run());
    await settle();
    expect(screen.getByRole('table')).toBeTruthy();
    await choosePreset('Shared addresses');
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Result' })).toBeNull();
    await choosePreset('Shared devices');
    expect(screen.getByRole('table')).toBeTruthy();
  });

  it('lets the buttons of a state wrap, so that a label never breaks inside a button', () => {
    const css = readFileSync(join(import.meta.dirname, '../styles/patterns.css'), 'utf8');
    const actions = /\.patterns-actions \{[^}]*\}/.exec(css)?.[0] ?? '';
    expect(actions).toContain('flex-wrap: wrap');
    expect(/\.patterns-actions button \{[^}]*white-space: nowrap/.test(css)).toBe(true);
  });

  it('shows the source timeout beside Run, and no number when the source states none', async () => {
    await patternsWorkspace();
    await openBuiltIn();
    expect(screen.getByText('5 s timeout')).toBeTruthy();
    cleanup();
    document.body.replaceChildren();
    await patternsWorkspace({ timeoutMs: null });
    await openBuiltIn();
    expect(screen.queryByText(/timeout/)).toBeNull();
  });

  it('has no Save pattern control in any state', async () => {
    const kit = await patternsWorkspace();
    await openBuiltIn();
    selectAccount(kit.state, 'acc-1');
    expect(screen.queryByText(/Save pattern/)).toBeNull();
    await userEvent.click(run());
    await settle();
    expect(screen.queryByText(/Save pattern/)).toBeNull();
  });

  it('keeps the list order the answer gives', async () => {
    await patternsWorkspace({ list: async () => ({ ok: true, value: listOf([CONNECTED, SHARED_DEVICES]) }) });
    await openPatterns();
    const rows = within(screen.getByRole('region', { name: /^Built-in/ })).getAllByRole('listitem');
    expect(rows.map((row) => row.querySelector('.pattern-row-name')?.textContent)).toEqual(['Connected accounts', 'Shared devices']);
  });

  it('lists exactly the two presets of the insurance pack for a source that declares them', async () => {
    const claimant = { ...SHARED_DEVICES, id: 'shared-addresses', name: 'Shared addresses', bind: { anchor: 'kind-a', attribute: 'kind-c', via: 'LINKS_A' }, labels: [{ key: 'anchor', text: 'Starting claimant' }] };
    const claims = { ...CONNECTED, id: 'claimant-claims', name: 'Claims by claimant', bind: { anchor: 'kind-a', target: 'kind-b', via: 'LINKS_B' }, labels: [{ key: 'anchor', text: 'Starting claimant' }] };
    await patternsWorkspace({ list: async () => ({ ok: true, value: listOf([claimant, claims]) }) });
    await openPatterns();
    expect(within(screen.getByRole('region', { name: /^Built-in/ })).getAllByRole('listitem').map((row) => row.querySelector('.pattern-row-name')?.textContent)).toEqual(['Shared addresses', 'Claims by claimant']);
    await userEvent.click(screen.getByRole('button', { name: 'Run Shared addresses' }));
    expect(screen.getByLabelText('Starting claimant')).toBeTruthy();
  });
});
