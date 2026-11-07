import { act, cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DegreePreview } from '@neburyx/contracts';
import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import type { ApiResult } from '../api/client.js';
import { fakeClient } from '../api/fake-client.js';
import { createPreviewStore } from '../api/preview-store.js';
import { createClientState } from '../state/client-state.js';
import type { RightClick } from '../canvas/scene.js';
import { loadGraph, nodeKey, show } from './context-menu-kit.js';
import { MENU_GROUP, MENU_ORDER } from './menu-registry.js';
import { PreviewProvider } from './preview-context.js';
import { createMenuRegistry } from './menu-registry.js';
import { registerBuiltInMenuItems } from './built-in-menu-items.js';
import { node } from '../state/test-data.js';

afterEach(() => cleanup());

const count = (value: number | undefined, quality: 'exact' | 'lowerBound' | 'unknown', scope = 'x') => (value === undefined ? { quality: 'unknown' as const, scope } : { value, quality, scope });
const answerFor = (overrides: Partial<DegreePreview> = {}): DegreePreview => ({
  ref: { sourceId: 'a', entityType: 'type-a', stableId: 'n1' },
  total: count(512, 'lowerBound'),
  byType: [],
  byNeighborType: [
    { entityType: 'type-a', count: count(12, 'exact') },
    { entityType: 'type-b', count: count(500, 'lowerBound') },
    { entityType: 'type-c', count: count(undefined, 'unknown') },
  ],
  warnings: [],
  ...overrides,
});

interface Ask {
  readonly body: { sourceId: string; ref: { entityType: string; stableId: string }; mask?: boolean };
  readonly answer: (result: ApiResult<DegreePreview>) => void;
}

function opened(open = true) {
  const asked: Ask[] = [];
  const store = createPreviewStore(
    fakeClient({
      previewExpansion: (body) =>
        new Promise((resolve) => {
          asked.push({ body, answer: resolve });
        }),
    }),
    () => 'person-1',
  );
  const state = createClientState();
  loadGraph(state, [node('a', 'n1'), node('a', 'n2')], []);
  const view = show(state, {}, undefined, null, (tree) => <PreviewProvider store={store}>{tree}</PreviewProvider>);
  const rightClick = (target: string): RightClick => ({ target: { kind: 'node', key: nodeKey(target) }, x: 50, y: 60 });
  if (open) view.rightClick(rightClick('n1'));
  return { asked, state, store, view, rightClick };
}

const nodeMenuRow = (): HTMLElement => within(screen.getByRole('menu', { name: 'n1' })).getByRole('menuitem', { name: 'Expand neighbors' });
const submenu = (): HTMLElement => screen.getByRole('group', { name: 'Expand by neighbor type' });
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

describe('the Expand neighbors entry of the node menu', () => {
  it('is registered in the expand group at the place the design gives it, with a submenu', () => {
    const registry = createMenuRegistry();
    registerBuiltInMenuItems(registry);
    const entry = registry.view.getState().get('node')?.find((candidate) => candidate.id === 'expand-neighbors');
    expect(entry).toMatchObject({ label: 'Expand neighbors', group: MENU_GROUP.node.expand, order: MENU_ORDER.node.expandNeighbors });
    expect(entry?.submenu).toBeDefined();
  });

  it('asks nothing until the entry is opened, then asks once for the node of the menu, without the mask flag', async () => {
    const { asked } = opened();
    expect(asked).toHaveLength(0);
    await userEvent.setup().click(nodeMenuRow());
    expect(asked).toHaveLength(1);
    expect(asked[0]?.body).toEqual({ sourceId: 'a', ref: { entityType: 'type-a', stableId: 'n1' } });
    expect(within(submenu()).getByRole('status').textContent).toBe('Loading neighbor types');
  });

  it('lists the neighbor types in the order of the answer with the display name from the profile (the type name when it has none) and the quality beside each count', async () => {
    const { asked } = opened();
    await userEvent.setup().click(nodeMenuRow());
    await act(async () => asked[0]?.answer({ ok: true, value: answerFor() }));
    const rows = within(within(submenu()).getByRole('list', { name: 'Neighbor types' })).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual(['TYPE-A12 · exact', 'type-b≥ 500 · lower bound', 'type-cno count']);
    expect(within(submenu()).getByText('Counts are of relationships.')).not.toBeNull();
  });

  it('says a count was capped, once, with the reason the server gave', async () => {
    const { asked } = opened();
    await userEvent.setup().click(nodeMenuRow());
    const warnings = [
      { code: 'counts-capped' as const, relationshipType: 'LINKS', reason: 'Counts are capped for this entity type' },
      { code: 'counts-capped' as const, relationshipType: 'KNOWS', reason: 'Counts are capped for this entity type' },
    ];
    await act(async () => asked[0]?.answer({ ok: true, value: answerFor({ warnings }) }));
    expect(within(submenu()).getAllByText('Counts are capped for this entity type.')).toHaveLength(1);
  });

  it('says so when the entity type has no mapped relationships', async () => {
    const { asked } = opened();
    await userEvent.setup().click(nodeMenuRow());
    await act(async () => asked[0]?.answer({ ok: true, value: answerFor({ byNeighborType: [], total: count(0, 'exact') }) }));
    expect(within(submenu()).getByText('No relationships are mapped for this entity type.')).not.toBeNull();
  });

  it('shows the failure with Retry, keeps the loaded graph, and asks again on Retry', async () => {
    const { asked, state } = opened();
    const before = state.loadedGraph().nodes.length;
    const user = userEvent.setup();
    await user.click(nodeMenuRow());
    await act(async () => asked[0]?.answer({ ok: false, failure: { code: 'QUERY_TIMEOUT', message: 'x', retryable: true, traceId: 'tr-9' } }));
    expect(within(submenu()).getByRole('alert').textContent).toBe('QUERY_TIMEOUT · trace tr-9');
    expect(state.loadedGraph().nodes).toHaveLength(before);
    await user.click(within(submenu()).getByRole('button', { name: 'Retry' }));
    expect(asked).toHaveLength(2);
    await act(async () => asked[1]?.answer({ ok: true, value: answerFor() }));
    expect(within(submenu()).getAllByRole('listitem')).toHaveLength(3);
  });

  it('moves the focus to Retry when a failure arrives after a keyboard opening, and retries from the keyboard alone', async () => {
    const { asked } = opened();
    const user = userEvent.setup();
    nodeMenuRow().focus();
    await user.keyboard('{Enter}');
    expect(within(submenu()).getByRole('status')).not.toBeNull();
    await act(async () => asked[0]?.answer({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }));
    const retry = within(submenu()).getByRole('button', { name: 'Retry' });
    expect(document.activeElement).toBe(retry);
    await user.keyboard('{Enter}');
    expect(asked).toHaveLength(2);
    expect(submenu().contains(document.activeElement)).toBe(true);
    await act(async () => asked[1]?.answer({ ok: true, value: answerFor() }));
    expect(within(submenu()).getAllByRole('listitem')).toHaveLength(3);
    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(nodeMenuRow());
  });

  it('does not ask again when the entry is opened a second time, nor when the menu is opened for the node again', async () => {
    const { asked, view, rightClick } = opened();
    const user = userEvent.setup();
    await user.click(nodeMenuRow());
    await act(async () => asked[0]?.answer({ ok: true, value: answerFor() }));
    view.rightClick(rightClick('n2'));
    view.rightClick(rightClick('n1'));
    await user.click(nodeMenuRow());
    expect(asked).toHaveLength(1);
    expect(within(submenu()).getAllByRole('listitem')).toHaveLength(3);
  });

  it('asks for the masked preview when the session masks, and keeps it apart from the unmasked one', async () => {
    const { asked, state, view, rightClick } = opened(false);
    state.setMask(true);
    view.rightClick(rightClick('n1'));
    const user = userEvent.setup();
    await user.click(nodeMenuRow());
    expect(asked[0]?.body).toEqual({ sourceId: 'a', ref: { entityType: 'type-a', stableId: 'n1' }, mask: true });
    state.setMask(false);
    view.rightClick(rightClick('n2'));
    view.rightClick(rightClick('n1'));
    await user.click(nodeMenuRow());
    expect(asked).toHaveLength(2);
    expect(asked[1]?.body).toEqual({ sourceId: 'a', ref: { entityType: 'type-a', stableId: 'n1' } });
  });

  it('never shows the answer for one node in the menu of another', async () => {
    const { asked, view, rightClick } = opened();
    const user = userEvent.setup();
    await user.click(nodeMenuRow());
    view.rightClick(rightClick('n2'));
    await settle();
    await user.click(within(screen.getByRole('menu', { name: 'n2' })).getByRole('menuitem', { name: 'Expand neighbors' }));
    expect(asked.map((ask) => ask.body.ref.stableId)).toEqual(['n1', 'n2']);
    await act(async () => asked[0]?.answer({ ok: true, value: answerFor() }));
    expect(within(submenu()).getByRole('status').textContent).toBe('Loading neighbor types');
  });

  it('is reached with the keyboard, read as type, count and quality, and Escape returns to the entry', async () => {
    const { asked } = opened();
    const user = userEvent.setup();
    nodeMenuRow().focus();
    await user.keyboard('{Enter}');
    await act(async () => asked[0]?.answer({ ok: true, value: answerFor() }));
    expect(within(submenu()).getByRole('list', { name: 'Neighbor types' })).not.toBeNull();
    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(nodeMenuRow());
  });

  it('has no Expand button and loads no neighbors', async () => {
    const { asked, state } = opened();
    const before = state.loadedGraph().nodes.length;
    await userEvent.setup().click(nodeMenuRow());
    await act(async () => asked[0]?.answer({ ok: true, value: answerFor() }));
    expect(within(submenu()).queryByRole('button')).toBeNull();
    expect(state.loadedGraph().nodes).toHaveLength(before);
  });

  const recordFocus = (): Array<{ readonly target: HTMLElement; readonly focusVisible: boolean | undefined }> => {
    const calls: Array<{ target: HTMLElement; focusVisible: boolean | undefined }> = [];
    const original = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (this: HTMLElement, options?: FocusOptions & { focusVisible?: boolean }) {
      calls.push({ target: this, focusVisible: options?.focusVisible });
      return original.call(this, options);
    };
    onTestFinished(() => {
      HTMLElement.prototype.focus = original;
    });
    return calls;
  };
  const inSubmenu = (element: HTMLElement): boolean => submenu().closest('.menu-panel')?.contains(element) === true;

  it('takes the focus into the panel when it is opened with the mouse, without a ring, and puts it on the first row when the answer arrives', async () => {
    const { asked } = opened();
    const calls = recordFocus();
    await userEvent.setup().click(nodeMenuRow());
    expect(inSubmenu(document.activeElement as HTMLElement)).toBe(true);
    await act(async () => asked[0]?.answer({ ok: true, value: answerFor() }));
    expect(document.activeElement).toBe(within(submenu()).getAllByRole('listitem')[0]);
    const inside = calls.filter((call) => inSubmenu(call.target));
    expect(inside.length).toBeGreaterThan(0);
    expect(inside.every((call) => call.focusVisible === false)).toBe(true);
  });

  it('puts the ring on the first row when it is opened with the keyboard, also when the answer arrives later', async () => {
    const { asked } = opened();
    const calls = recordFocus();
    const user = userEvent.setup();
    nodeMenuRow().focus();
    await user.keyboard('{Enter}');
    await settle();
    expect(inSubmenu(document.activeElement as HTMLElement)).toBe(true);
    expect(document.activeElement?.classList.contains('neighbor-types-row')).toBe(false);
    await act(async () => asked[0]?.answer({ ok: true, value: answerFor() }));
    expect(document.activeElement).toBe(within(submenu()).getAllByRole('listitem')[0]);
    const inside = calls.filter((call) => inSubmenu(call.target));
    expect(inside.every((call) => call.focusVisible !== false)).toBe(true);
  });

  it('moves between the rows with the arrow keys, Home and End, and Escape returns to the entry', async () => {
    const { asked } = opened();
    const user = userEvent.setup();
    nodeMenuRow().focus();
    await user.keyboard('{Enter}');
    await act(async () => asked[0]?.answer({ ok: true, value: answerFor() }));
    const rows = within(submenu()).getAllByRole('listitem');
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(rows[1]);
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(rows[2]);
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(rows[0]);
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(rows[2]);
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(rows[0]);
    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(nodeMenuRow());
  });

  it('moves the focus to Retry when a failure arrives after a mouse opening too', async () => {
    const { asked } = opened();
    await userEvent.setup().click(nodeMenuRow());
    await act(async () => asked[0]?.answer({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }));
    expect(document.activeElement).toBe(within(submenu()).getByRole('button', { name: 'Retry' }));
  });

  it('says the note of the list when the list is described', async () => {
    const { asked } = opened();
    await userEvent.setup().click(nodeMenuRow());
    await act(async () => asked[0]?.answer({ ok: true, value: answerFor() }));
    const first = within(submenu()).getAllByRole('listitem')[0] as HTMLElement;
    expect(first.getAttribute('aria-describedby')).not.toBeNull();
    expect(document.getElementById(first.getAttribute('aria-describedby') as string)?.textContent).toContain('Counts are of relationships.');
  });
});
