import { vi } from 'vitest';

/** A BroadcastChannel in memory for the tests of the windows of one browser: a message reaches every other channel of the same name at once. */
export function installFakeBroadcastChannel(): () => void {
  const open = new Map<string, Set<FakeChannel>>();
  class FakeChannel {
    onmessage: ((event: { readonly data: unknown }) => void) | null = null;
    constructor(readonly name: string) {
      const set = open.get(name) ?? new Set<FakeChannel>();
      set.add(this);
      open.set(name, set);
    }
    postMessage(data: unknown): void {
      for (const other of open.get(this.name) ?? []) if (other !== this) other.onmessage?.({ data });
    }
    close(): void {
      open.get(this.name)?.delete(this);
    }
  }
  vi.stubGlobal('BroadcastChannel', FakeChannel);
  return () => vi.unstubAllGlobals();
}
