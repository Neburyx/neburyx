import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AskRefusalFamily } from '@neburyx/contracts';
import { createToolRegistry, TOOL_ORDER, type ToolRegistry } from '../workspace/tool-registry.js';
import { answerAsk, drawAsk, field, previewOf, type AskHarness } from './ask-kit.js';
import { CHIP_LABELS, EXPAND_HINT } from './refusal-chips.js';

afterEach(cleanup);

async function refused(family: AskRefusalFamily, tools?: ToolRegistry): Promise<AskHarness> {
  const harness = drawAsk(tools === undefined ? {} : { tools });
  await userEvent.type(field(), 'which widgets');
  await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
  await answerAsk(harness.asks[0], previewOf('which widgets'));
  await userEvent.click(screen.getByRole('button', { name: 'Send' }));
  await answerAsk(harness.asks[1], { ok: true, value: { plan: { kind: 'unsupported', family, reason: 'Fixed words of the server.' } } });
  return harness;
}

const card = (): HTMLElement => screen.getByRole('region', { name: 'This question was not answered' });
const chipNames = (): string[] => Array.from(card().querySelectorAll('button')).map((button) => button.textContent ?? '');

const ONLY_EXPAND = ['similar-records', 'attribute-combination', 'indirect-attribute', 'unnamed-relation', 'judgement'] as const;

describe('the chips of a refusal card', () => {
  it('offers Open Filters and Search for property-selection, with the line that says what each does', async () => {
    await refused('property-selection');
    expect(chipNames()).toEqual(['Open Filters', 'Search']);
    expect(card().textContent).toContain('Filters narrows the loaded items by type, not by a value.');
    expect(card().textContent).toContain('Search also matches the values of indexed properties.');
  });

  it.each(ONLY_EXPAND)('offers Expand alone for %s, with the card\'s own line', async (family) => {
    await refused(family);
    expect(chipNames()).toEqual(['Expand']);
    expect(card().textContent).toContain(EXPAND_HINT);
  });

  it('offers Search by stable ID alone for personal-data', async () => {
    await refused('personal-data');
    expect(chipNames()).toEqual(['Search by stable ID']);
  });

  it.each(['ranking-or-aggregate', 'loaded-view'] as const)('offers no chip for %s and says there is no alternative in this release', async (family) => {
    await refused(family);
    expect(chipNames()).toEqual([]);
    expect(card().textContent).toContain('There is no alternative for this in this release.');
  });

  it.each(['other', 'plan-not-usable', 'model-refused'] as const)('offers Search by stable ID, Open Filters and Expand for %s', async (family) => {
    await refused(family);
    expect(chipNames()).toEqual(['Search by stable ID', 'Open Filters', 'Expand']);
  });

  it('opens Filters from Open Filters, and the card stays', async () => {
    const { state, asks } = await refused('property-selection');
    await userEvent.click(screen.getByRole('button', { name: CHIP_LABELS.filters }));
    expect(state.presentation.view.getState().filtersOpen).toBe(true);
    expect(card()).toBeTruthy();
    expect(asks).toHaveLength(2);
  });

  it.each([['search', 'property-selection'], ['search-id', 'personal-data']] as const)('opens Search on its source tab, asking for the focus, from the chip %s', async (chip, family) => {
    const { state, asks } = await refused(family);
    const before = state.presentation.view.getState().searchFocus;
    await userEvent.click(screen.getByRole('button', { name: CHIP_LABELS[chip] }));
    const view = state.presentation.view.getState();
    expect(view.searchOpen).toBe(true);
    expect(view.searchTab).toBe('source');
    expect(view.searchFocus).toBe(before + 1);
    expect(asks).toHaveLength(2);
  });

  it('puts the focus on the graph canvas from Expand, whether nothing, one entity or many are loaded', async () => {
    await refused('judgement');
    const canvas = document.createElement('div');
    canvas.className = 'graph-canvas';
    canvas.tabIndex = 0;
    document.body.append(canvas);
    for (const loaded of [0, 1, 40]) {
      canvas.dataset['loaded'] = String(loaded);
      screen.getByRole('button', { name: 'Expand' }).focus();
      await userEvent.click(screen.getByRole('button', { name: 'Expand' }));
      expect(document.activeElement).toBe(canvas);
    }
    canvas.remove();
  });

  it('offers Expand for path today, and Open Paths only for an action tool registered as paths, which it runs', async () => {
    await refused('path');
    expect(chipNames()).toEqual(['Expand']);
    cleanup();
    const activate = vi.fn();
    const tools = createToolRegistry();
    tools.register({ id: 'paths', label: 'Paths', icon: null, order: TOOL_ORDER.paths, kind: { type: 'action', activate } });
    await refused('path', tools);
    expect(chipNames()).toEqual(['Open Paths']);
    expect(card().textContent).toContain('Open Paths to see how two entities are connected.');
    expect(card().textContent).not.toContain('Expand each entity');
    await userEvent.click(screen.getByRole('button', { name: 'Open Paths' }));
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it('does not offer Open Paths for a flyout tool under that id', async () => {
    const tools = createToolRegistry();
    tools.register({ id: 'paths', label: 'Paths', icon: null, order: TOOL_ORDER.paths, kind: { type: 'flyout', content: () => null } });
    await refused('path', tools);
    expect(chipNames()).toEqual(['Expand']);
  });

  it('reaches each chip by Tab after the card, with a name, and sends nothing', async () => {
    const { asks } = await refused('other');
    card().focus();
    await userEvent.tab();
    expect(document.activeElement?.textContent).toBe('Search by stable ID');
    await userEvent.tab();
    expect(document.activeElement?.textContent).toBe('Open Filters');
    await userEvent.tab();
    expect(document.activeElement?.textContent).toBe('Expand');
    expect(asks).toHaveLength(2);
  });
});
