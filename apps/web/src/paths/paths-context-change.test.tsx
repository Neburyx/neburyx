import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { PathsResponse } from '@neburyx/contracts';
import type { ApiResult } from '../api/client.js';
import { chooseEnd, okPaths, openPaths, pathsWorkspace, settle, type SentSearch } from './paths-kit.js';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const find = (): HTMLElement => screen.getByRole('button', { name: 'Find paths' });
const heavy: PathsResponse = { status: 'heavy', estimate: { value: 500, quality: 'lowerBound', scope: 'paths:estimate' }, threshold: 500, continueLimit: 25, warnings: [] };

interface Held {
  readonly sent: SentSearch;
  readonly answer: (result: ApiResult<PathsResponse>) => void;
}

function holding() {
  const held: Held[] = [];
  const handler = (sent: SentSearch): Promise<ApiResult<PathsResponse>> =>
    new Promise((resolve) => {
      held.push({ sent, answer: resolve });
      sent.signal?.addEventListener('abort', () => resolve({ ok: false, failure: { code: 'ABORTED' } }));
    });
  return { held, handler };
}

async function startAndClose(): Promise<void> {
  await openPaths();
  chooseEnd('From', 'acc-1');
  chooseEnd('To', 'acc-2');
  await userEvent.click(find());
  await settle();
  fireEvent.click(screen.getByRole('button', { name: 'Close Paths' }));
  await settle();
}

describe('the banners of a search follow the answer, not the panel', () => {
  it('shows the Heavy and the Partial banner for an answer that arrives while the panel is closed', async () => {
    const heavyRun = holding();
    const kit = await pathsWorkspace({ find: heavyRun.handler });
    await startAndClose();
    expect(screen.queryByRole('heading', { name: 'Bounded path search' })).toBeNull();
    heavyRun.held[0]?.answer({ ok: true, value: heavy });
    await settle();
    expect(kit.banner.view.getState().banner).toMatchObject({ id: 'heavy', headline: 'Estimated ≥ 500 matches · warning threshold 500' });
    cleanup();
    document.body.replaceChildren();
    const partialRun = holding();
    const second = await pathsWorkspace({ find: partialRun.handler });
    await startAndClose();
    partialRun.held[0]?.answer({ ok: true, value: okPaths([['acc-1', 'acc-2']], { partial: true, retained: 1, requested: 5 }) });
    await settle();
    expect(second.banner.view.getState().banner).toMatchObject({ id: 'partial' });
  });

  it('does not bring a dismissed banner back when the panel is opened again', async () => {
    const run = holding();
    const kit = await pathsWorkspace({ find: run.handler });
    await startAndClose();
    run.held[0]?.answer({ ok: true, value: heavy });
    await settle();
    act(() => kit.banner.dismiss('heavy'));
    await openPaths();
    expect(kit.banner.view.getState().banner).toBeUndefined();
  });

  it('puts the focus on the first path when Review is used on a closed panel', async () => {
    const run = holding();
    const kit = await pathsWorkspace({ find: run.handler });
    await startAndClose();
    run.held[0]?.answer({ ok: true, value: okPaths([['acc-1', 'acc-2']], { partial: true, retained: 1, requested: 5 }) });
    await settle();
    const review = kit.banner.view.getState().banner?.actions.find((action) => action.id === 'review');
    act(() => review?.run());
    await settle();
    expect(screen.getByRole('heading', { name: 'Bounded path search' })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getAllByRole('button', { name: /^Path 1/ })[0]);
  });
});

describe('a search belongs to the source, the investigation and the mask it was made under', () => {
  it('drops the list and the banners of a search when the mask is turned on, also while the panel is closed', async () => {
    const run = holding();
    const kit = await pathsWorkspace({ find: run.handler });
    await openPaths();
    chooseEnd('From', 'acc-1');
    chooseEnd('To', 'acc-2');
    await userEvent.click(find());
    await settle();
    run.held[0]?.answer({ ok: true, value: heavy });
    await settle();
    expect(kit.banner.view.getState().banner?.id).toBe('heavy');
    fireEvent.click(screen.getByRole('button', { name: 'Close Paths' }));
    await settle();
    act(() => kit.state.setMask(true));
    await settle();
    expect(kit.banner.view.getState().banner).toBeUndefined();
  });

  it('shows no list from the earlier mask when the panel is opened after the mask changed, and sends the new mask on the next search', async () => {
    const kit = await pathsWorkspace({ find: async () => ({ ok: true, value: okPaths([['acc-1', 'acc-2']]) }) });
    await openPaths();
    chooseEnd('From', 'acc-1');
    chooseEnd('To', 'acc-2');
    await userEvent.click(find());
    await settle();
    expect(screen.getByRole('list', { name: 'Paths found' })).toBeTruthy();
    act(() => kit.state.setMask(true));
    await settle();
    expect(screen.queryByRole('list', { name: 'Paths found' })).toBeNull();
    chooseEnd('From', 'acc-1');
    chooseEnd('To', 'acc-2');
    await userEvent.click(find());
    await settle();
    expect(kit.sent.at(-1)?.request.mask).toBe(true);
  });

  it('drops the search of an investigation when another one is opened on the same source', async () => {
    const kit = await pathsWorkspace({ find: async () => ({ ok: true, value: okPaths([['acc-1', 'acc-2']]) }) });
    await openPaths();
    chooseEnd('From', 'acc-1');
    chooseEnd('To', 'acc-2');
    await userEvent.click(find());
    await settle();
    expect(screen.getByRole('list', { name: 'Paths found' })).toBeTruthy();
    const sourceId = kit.state.investigation.getState().sourceId ?? '';
    act(() => {
      kit.state.show({ id: '0192f000-0000-7000-8000-0000000000aa', sourceId, record: { title: 'Other', caseRef: null, status: 'open', readOnly: false, version: 1, save: { kind: 'unsaved' } }, resultKeys: [], nodeRefs: [], edgeRefs: [] }, []);
    });
    await settle();
    expect(screen.queryByRole('list', { name: 'Paths found' })).toBeNull();
  });
});
