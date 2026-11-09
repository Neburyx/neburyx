import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { edgeKey } from '../state/keys.js';
import { select } from './inspector-kit.js';
import { answerPreview, openRelationships, previewOf, rowNames, stored } from './relationship-kit.js';

const ids = ['n2', 'n3', 'n4', 'n5', 'n6'];
const edges = ids.map((id, index) => stored(`r${index}`, 'n1', id));
const rows = (): HTMLElement[] => screen.getAllByRole('button').filter((button) => button.classList.contains('relationship-row'));

describe('the Relationships tab: keyboard and paging', () => {
  it('reaches every row with Tab, in order, and selects with Enter and with Space', async () => {
    const rig = await openRelationships(edges.slice(0, 3), ids);
    const [, second, third] = edges.map((edge) => edgeKey(edge.ref));
    const user = userEvent.setup();
    screen.getByRole('tab', { name: 'Relationships' }).focus();
    await user.tab();
    expect(document.activeElement).toBe(rows()[0]);
    await user.tab();
    expect(document.activeElement).toBe(rows()[1]);
    await user.keyboard('{Enter}');
    expect([...rig.state.presentation.view.getState().selection]).toEqual([second]);
    await user.tab();
    await user.keyboard(' ');
    expect([...rig.state.presentation.view.getState().selection]).toEqual([third]);
    expect(rows()[2]?.getAttribute('aria-current')).toBe('true');
    expect(rows()[1]?.getAttribute('aria-current')).toBeNull();
  });

  it('names each row by type, other end and direction', async () => {
    await openRelationships([stored('r1', 'n1', 'n2'), stored('r2', 'n3', 'n1', 'USES')], ids);
    expect(rowNames()).toEqual(['OWNS, Title n2 · Kind A, from this entity', 'USES, Title n3 · Kind A, to this entity']);
  });

  it('draws one page of a group with Show more, which draws the next page and moves the focus to the first new row, and goes when none remain', async () => {
    const rig = await openRelationships(edges, ids);
    await answerPreview(rig, previewOf({ pageSize: 2 }));
    expect(rows()).toHaveLength(2);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    expect(rows()).toHaveLength(4);
    expect(document.activeElement).toBe(rows()[2]);
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    expect(rows()).toHaveLength(5);
    expect(document.activeElement).toBe(rows()[4]);
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('starts the next entity at one page, not at the pages opened for the one before', async () => {
    const rig = await openRelationships([...edges, ...ids.map((id, index) => stored(`s${index}`, 'n7', id))], [...ids, 'n7']);
    await answerPreview(rig, previewOf({ pageSize: 2 }));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Show more' }));
    expect(rows()).toHaveLength(4);
    act(() => select(rig.state, 'n7'));
    await act(async () => rig.previews[1]?.answer({ ok: true, value: previewOf({ pageSize: 2 }) }));
    expect(rows()).toHaveLength(2);
  });

  it('draws no Show more for exactly one page of rows', async () => {
    const rig = await openRelationships(edges.slice(0, 2), ids);
    await answerPreview(rig, previewOf({ pageSize: 2 }));
    expect(rows()).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('uses the expansion fallback page of 25 while there is no preview', async () => {
    const many = Array.from({ length: 26 }, (_, index) => `m${index}`);
    await openRelationships(many.map((id, index) => stored(`q${index}`, 'n1', id)), many);
    expect(rows()).toHaveLength(25);
    expect(screen.getByRole('button', { name: 'Show more' })).toBeTruthy();
  });
});
