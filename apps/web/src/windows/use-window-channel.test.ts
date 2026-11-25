import { describe, expect, it, vi } from 'vitest';
import { acquireWindowChannel, heldWindowChannel } from './use-window-channel.js';
import type { WindowScope } from './window-channel.js';

const SCOPE: WindowScope = { principalId: 'p-hook', investigationId: 'inv-1', sourceId: 'src-1' };

describe('the one channel of a window for a scope', () => {
  it('is shared by every part of the window that asks for it, and closed when the last lets it go', () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    const first = acquireWindowChannel(SCOPE);
    const channel = heldWindowChannel(SCOPE);
    const second = acquireWindowChannel(SCOPE);
    expect(heldWindowChannel(SCOPE)).toBe(channel);
    first();
    first();
    expect(heldWindowChannel(SCOPE)).toBe(channel);
    second();
    expect(heldWindowChannel(SCOPE)).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it('is another channel for another investigation or source of the same window', () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    const stops = [acquireWindowChannel(SCOPE), acquireWindowChannel({ ...SCOPE, investigationId: 'inv-2' }), acquireWindowChannel({ ...SCOPE, sourceId: 'src-2' })];
    expect(heldWindowChannel(SCOPE)).not.toBe(heldWindowChannel({ ...SCOPE, investigationId: 'inv-2' }));
    expect(heldWindowChannel(SCOPE)).not.toBe(heldWindowChannel({ ...SCOPE, sourceId: 'src-2' }));
    for (const stop of stops) stop();
    vi.unstubAllGlobals();
  });
});
