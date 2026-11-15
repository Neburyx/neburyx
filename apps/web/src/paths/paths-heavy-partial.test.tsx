import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { PathsResponse } from '@neburyx/contracts';
import { chooseEnd, okPaths, openPaths, pathsWorkspace, settle, type PathsKit } from './paths-kit.js';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const find = (): HTMLElement => screen.getByRole('button', { name: 'Find paths' });
const heavy = (threshold = 500, continueLimit = 25): PathsResponse => ({ status: 'heavy', estimate: { value: threshold, quality: 'lowerBound', scope: 'paths:estimate' }, threshold, continueLimit, warnings: [] });
const banner = (kit: PathsKit) => kit.banner.view.getState().banner;
const action = (kit: PathsKit, id: string): (() => void) => {
  const found = banner(kit)?.actions.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no banner action ${id}`);
  return found.run;
};

async function search(): Promise<void> {
  await openPaths();
  chooseEnd('From', 'acc-1');
  chooseEnd('To', 'acc-2');
  await userEvent.click(find());
  await settle();
}

describe('the heavy stop', () => {
  it('shows the Heavy operation banner with the lower bound at the threshold and its two actions, lists no new paths and keeps the previous list', async () => {
    let answers = 0;
    const kit = await pathsWorkspace({ find: async () => ({ ok: true, value: answers++ === 0 ? okPaths([['acc-1', 'acc-2']]) : heavy() }) });
    await search();
    await userEvent.click(find());
    await settle();
    expect(banner(kit)).toMatchObject({ id: 'heavy', headline: 'Estimated ≥ 500 matches · warning threshold 500', text: 'Refine filters or continue with a bounded limit of 25.' });
    expect(banner(kit)?.actions.map((entry) => entry.label)).toEqual(['Refine filters', 'Continue with 25']);
    expect(screen.getByRole('list', { name: 'Paths found' })).toBeTruthy();
  });

  it('sends the same request with continue on Continue with 25 and shows the answer as any answer, taking the banner down', async () => {
    let answers = 0;
    const kit = await pathsWorkspace({ find: async () => ({ ok: true, value: answers++ === 0 ? heavy() : okPaths([['acc-1', 'acc-2']]) }) });
    await search();
    act(() => action(kit, 'continue')());
    await settle();
    expect(kit.sent).toHaveLength(2);
    expect(kit.sent[1]?.request).toEqual({ ...kit.sent[0]?.request, continue: true });
    expect(banner(kit)).toBeUndefined();
    expect(screen.getByText('1 path · 0.42 s · cap not reached')).toBeTruthy();
  });

  it('moves the focus to From, takes the banner down and sends nothing on Refine filters', async () => {
    const kit = await pathsWorkspace({ find: async () => ({ ok: true, value: heavy() }) });
    await search();
    act(() => action(kit, 'refine')());
    await settle();
    expect(document.activeElement).toBe(screen.getByLabelText('From'));
    expect(banner(kit)).toBeUndefined();
    expect(kit.sent).toHaveLength(1);
  });

  it('leaves the loaded graph and the filters as they were', async () => {
    const kit = await pathsWorkspace({ find: async () => ({ ok: true, value: heavy() }) });
    const before = kit.state.loadedGraph().nodes.length;
    const filter = kit.state.presentation.view.getState().typeFilter;
    await search();
    expect(kit.state.loadedGraph().nodes).toHaveLength(before);
    expect(kit.state.presentation.view.getState().typeFilter).toBe(filter);
  });
});

describe('the partial answer', () => {
  const partial = (retained: number, requested: number, paths = retained): PathsResponse => {
    const answer = okPaths(Array.from({ length: paths }, (_unused, index) => ['acc-1', `via-${index}`, 'acc-2']), { partial: true, retained, requested, capReached: false });
    return answer;
  };

  it('shows the Partial banner with the counts, the timeout and Review, lists the retained paths and does not say the cap was not reached', async () => {
    const kit = await pathsWorkspace({ find: async () => ({ ok: true, value: partial(2, 5) }) });
    await search();
    expect(banner(kit)).toMatchObject({ id: 'partial', headline: '5 s timeout · 2 of 5 requested paths retained', sideLabel: '2 / 5 paths retained' });
    expect(banner(kit)?.actions.map((entry) => entry.label)).toEqual(['Review 2 paths']);
    expect(banner(kit)?.text).toContain('Partial, not exhaustive');
    expect(screen.getByText('2 paths · 0.42 s · partial')).toBeTruthy();
    expect(screen.queryByText(/cap not reached/)).toBeNull();
  });

  it('still says partial when the limit was read before the time ran out', async () => {
    const kit = await pathsWorkspace({ find: async () => ({ ok: true, value: partial(5, 5) }) });
    await search();
    expect(banner(kit)?.headline).toBe('5 s timeout · 5 of 5 requested paths retained');
    expect(screen.getByText('5 paths · 0.42 s · partial')).toBeTruthy();
  });

  it('focuses the first path on Review, adds nothing to the graph, and opens a closed panel', async () => {
    const kit = await pathsWorkspace({ find: async () => ({ ok: true, value: partial(2, 5) }) });
    await search();
    const before = kit.state.loadedGraph().nodes.length;
    act(() => action(kit, 'review')());
    await settle();
    expect(document.activeElement).toBe(screen.getAllByRole('button', { name: /^Path 1/ })[0]);
    expect(kit.state.loadedGraph().nodes).toHaveLength(before);
    fireEvent.click(screen.getByRole('button', { name: 'Close Paths' }));
    await settle();
    expect(screen.queryByRole('heading', { name: 'Bounded path search' })).toBeNull();
    act(() => action(kit, 'review')());
    await settle();
    expect(screen.getByRole('heading', { name: 'Bounded path search' })).toBeTruthy();
  });

  it('leaves the loaded graph and the filters as they were', async () => {
    const kit = await pathsWorkspace({ find: async () => ({ ok: true, value: partial(1, 5) }) });
    const before = kit.state.loadedGraph().nodes.length;
    await search();
    expect(kit.state.loadedGraph().nodes).toHaveLength(before);
  });
});
