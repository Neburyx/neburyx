import { act, cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { stored } from '../inspector/relationship-kit.js';
import { select } from '../inspector/inspector-kit.js';
import { answerEdge, detailOf, evidenceRig, inPanel, OWNS, panel, SENT, SHARED, SUMMED } from './evidence-kit.js';
import { edgeKey } from '../state/keys.js';

afterEach(cleanup);

const tab = () => screen.getByRole('tab', { name: 'Evidence' });
const rowNames = (): string[] => screen.queryAllByRole('button').filter((button) => button.classList.contains('relationship-row')).map((button) => button.getAttribute('aria-label') ?? '');

describe('the inspector Evidence tab', () => {
  it('is registered after Properties', () => {
    const rig = evidenceRig();
    select(rig.state, 'n1');
    expect(screen.getAllByRole('tab').map((entry) => entry.textContent)).toEqual(['Overview', 'Relationships', 'Properties', 'Evidence']);
    rig.unbind();
  });

  it('lists the drawn stored relationships of the entity and no aggregate, and makes no request', async () => {
    const rig = evidenceRig({}, [OWNS, SENT, SUMMED]);
    select(rig.state, 'n1');
    await act(async () => tab().click());
    expect(rowNames()).toEqual(['OWNS, Title n2 · Kind A', 'SENT, Title n3 · Kind A']);
    expect(rig.edgeCalls).toEqual([]);
    rig.unbind();
  });

  it('lists a derived relationship after the stored ones, whatever the order they were loaded in, and opens its evidence from the row', async () => {
    const rig = evidenceRig({}, [SHARED, OWNS, SENT, SUMMED]);
    select(rig.state, 'n1');
    await act(async () => tab().click());
    expect(rowNames()).toEqual(['OWNS, Title n2 · Kind A', 'SENT, Title n3 · Kind A', 'SHARED, Title n3 · Kind A']);
    await act(async () => screen.getByRole('button', { name: 'SHARED, Title n3 · Kind A' }).click());
    expect(panel()).not.toBeNull();
    expect(rig.edgeCalls).toHaveLength(1);
    rig.unbind();
  });

  it('says so when the entity has no drawn stored relationship', async () => {
    const rig = evidenceRig({}, [SUMMED]);
    select(rig.state, 'n1');
    await act(async () => tab().click());
    expect(screen.getByText('No stored or derived relationships of this entity are drawn.')).toBeTruthy();
    rig.unbind();
  });

  it('selects the relationship and opens the evidence panel from a row, the inspector staying on its entity and focus moving to the panel', async () => {
    const rig = evidenceRig();
    select(rig.state, 'n1');
    await act(async () => tab().click());
    await userEvent.click(screen.getByRole('button', { name: /^OWNS,/ }));
    expect([...rig.state.presentation.view.getState().selection]).toEqual([edgeKey(OWNS.ref)]);
    expect(screen.getByRole('complementary', { name: 'Inspector' })).toBeTruthy();
    await answerEdge(rig.edgeReads[0], detailOf(OWNS));
    await act(async () => undefined);
    expect(panel()).not.toBeNull();
    expect(document.activeElement).toBe(inPanel().getByRole('tab', { name: 'Evidence' }));
    expect(screen.getByRole('button', { name: /^OWNS,/ }).getAttribute('aria-current')).toBe('true');
    expect(screen.getByRole('button', { name: /^SENT,/ }).getAttribute('aria-current')).toBeNull();
    rig.unbind();
  });

  it('draws one page of 25 with Show more and keeps focus on the first new row', async () => {
    const edges = Array.from({ length: 30 }, (_value, index) => stored(`m${index}`, 'n1', 'n2', `T${String(index).padStart(2, '0')}`));
    const rig = evidenceRig({}, edges);
    select(rig.state, 'n1');
    await act(async () => tab().click());
    expect(rowNames()).toHaveLength(25);
    await userEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(rowNames()).toHaveLength(30);
    expect(rig.edgeCalls).toEqual([]);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^T25,/ }));
    rig.unbind();
  });
});
