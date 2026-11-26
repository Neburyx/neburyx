import { act, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DerivedNeighborsResponse } from '@neburyx/contracts';
import { DERIVED_ROWS_WAIT_MS, READ_WAIT_MS } from '../api/read-wait.js';
import { previewOf } from '../workspace/supernode-kit.js';
import { count, inInspector, inspectorRig, select, TYPE } from './inspector-kit.js';
import { at } from './relationship-kit.js';

beforeEach(() => void vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const wait = (ms = 0) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const press = async (element: HTMLElement) => {
  await act(async () => void fireEvent.click(element));
  await wait();
};
const UNREACHABLE = 'The server could not be reached.';
const RULE = { id: 'shared-device', from: TYPE, to: TYPE, via: ['link-a', TYPE, 'link-a'], ruleVersion: 2 };

describe('the inspector with a read that gets no answer', () => {
  it('ends the count of relationship ends at the bound, with Retry, which counts again', async () => {
    const rig = inspectorRig();
    select(rig.state, 'n1');
    const section = () => inInspector().getByRole('region', { name: 'Sourced relationship ends' });
    await wait(READ_WAIT_MS - 1);
    expect(section().textContent).toContain('Counting relationship ends…');
    expect(section().textContent).not.toContain(UNREACHABLE);
    await wait(1);
    expect(section().textContent).toContain(UNREACHABLE);
    expect(section().textContent).not.toContain('Counting relationship ends…');
    await press(section().querySelector('button') as HTMLButtonElement);
    expect(rig.previews).toHaveLength(2);
    expect(section().textContent).toContain('Counting relationship ends…');
    await act(async () => rig.previews[1]?.answer({ ok: true, value: previewOf() }));
    expect(document.body.textContent).not.toContain(UNREACHABLE);
    expect(document.body.textContent).not.toContain('Counting relationship ends…');
    rig.unbind();
  });

  it('ends the rule-derived rows at the longer bound, with Retry, and takes the answer that then comes after the usual wait', async () => {
    const rig = inspectorRig({ derivedRules: [RULE] });
    select(rig.state, 'n1');
    // the sourced count answers, so that the only failure on screen is that of the derived rows
    await act(async () => rig.previews[0]?.answer({ ok: true, value: previewOf() }));
    await wait(DERIVED_ROWS_WAIT_MS - 1);
    expect(inInspector().getByText('Counting rule-derived neighbors…')).toBeTruthy();
    expect(inInspector().queryByText(UNREACHABLE)).toBeNull();
    await wait(1);
    expect(inInspector().getByText(UNREACHABLE)).toBeTruthy();
    expect(inInspector().queryByText('Counting rule-derived neighbors…')).toBeNull();
    await press(inInspector().getByRole('button', { name: 'Retry' }));
    expect(rig.derivedCalls).toHaveLength(2);
    await wait(READ_WAIT_MS + 5000);
    expect(rig.derivedCalls[1]?.signal?.aborted).toBe(false);
    const value: DerivedNeighborsResponse = { ref: at('n1'), results: [{ ruleId: 'shared-device', ruleVersion: 2, count: count(1, 'exact'), nodes: [], edges: [], warnings: [] }] };
    await act(async () => rig.derived[1]?.answer({ ok: true, value }));
    expect(inInspector().getByRole('group', { name: /^Linked/ }).textContent).toBe('Linked Kind A · 1 · rule-derived');
    expect(inInspector().queryByText(UNREACHABLE)).toBeNull();
    rig.unbind();
  });
});
