import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { READ_WAIT_MS } from '../api/read-wait.js';
import { panelRig } from './supernode-kit.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('an expansion whose count gets no answer', () => {
  it('waits for the count only as long as a read may, then takes it as unknown: no warning, no number, and the first page is asked for', async () => {
    const { rightClick, previews, expansions, previewStore } = panelRig({ heavy: true });
    rightClick('n1');
    vi.useFakeTimers();
    await act(async () => void fireEvent.click(screen.getByRole('menuitem', { name: 'Expand neighbors' })));
    expect(previews).toHaveLength(1);
    await act(async () => void (await vi.advanceTimersByTimeAsync(READ_WAIT_MS - 1)));
    expect(expansions).toHaveLength(0);
    await act(async () => void (await vi.advanceTimersByTimeAsync(1)));
    expect(expansions).toHaveLength(1);
    expect(expansions[0]?.body.limit).toBeUndefined();
    expect(screen.queryByRole('region', { name: 'Request status' })?.textContent ?? '').not.toContain('Estimated');
    const asked = previews[0]?.body;
    expect(previewStore.held({ sourceId: asked?.sourceId ?? '', entityType: asked?.ref.entityType ?? '', stableId: asked?.ref.stableId ?? '' }, false)).toBeUndefined();
  });
});
