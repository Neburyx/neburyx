import { useEffect, useState, useSyncExternalStore } from 'react';
import { useClientState } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { usePrincipalIdWhenProvided } from '../shell/shell-data.js';
import { createWindowChannel, type WindowChannel, type WindowRole, type WindowScope } from './window-channel.js';

const NO_ROLES: ReadonlySet<WindowRole> = new Set();
const NO_CHANGE = (): (() => void) => () => undefined;

const held = new Map<string, { readonly channel: WindowChannel; refs: number }>();

/** One channel for this window and scope, shared by every hook that asks for it, so that two parts of a window never hear one another as other windows. */
export function acquireWindowChannel(scope: WindowScope): () => void {
  const key = JSON.stringify([scope.principalId, scope.investigationId, scope.sourceId]);
  const entry = held.get(key) ?? { channel: createWindowChannel(scope), refs: 0 };
  entry.refs += 1;
  held.set(key, entry);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    held.delete(key);
    entry.channel.close();
  };
}

export function heldWindowChannel(scope: WindowScope): WindowChannel | undefined {
  return held.get(JSON.stringify([scope.principalId, scope.investigationId, scope.sourceId]))?.channel;
}

/** The scope this window is in: the person, and the investigation and source it holds; none until all three are known. */
export function useWindowScope(): WindowScope | null {
  const state = useClientState();
  const principalId = usePrincipalIdWhenProvided();
  const investigationId = useStoreSelector(state.investigation, (investigation) => investigation.id);
  const sourceId = useStoreSelector(state.investigation, (investigation) => investigation.sourceId);
  return principalId === undefined || investigationId === null || sourceId === null ? null : { principalId, investigationId, sourceId };
}

/** The channel of this window for the scope, from the first render after it is made; `undefined` before, and with no scope. */
export function useWindowChannel(scope: WindowScope | null): WindowChannel | undefined {
  const [channel, setChannel] = useState<WindowChannel | undefined>(undefined);
  const principalId = scope?.principalId;
  const investigationId = scope?.investigationId;
  const sourceId = scope?.sourceId;
  useEffect(() => {
    if (principalId === undefined || investigationId === undefined || sourceId === undefined) {
      setChannel(undefined);
      return undefined;
    }
    const next = { principalId, investigationId, sourceId };
    const release = acquireWindowChannel(next);
    setChannel(heldWindowChannel(next));
    return () => {
      release();
      setChannel(undefined);
    };
  }, [principalId, investigationId, sourceId]);
  return channel;
}

/** Says that this window is open in the role while it is shown, for the scope it is in. */
export function useAnnounceWindow(role: WindowRole): void {
  const channel = useWindowChannel(useWindowScope());
  useEffect(() => (channel === undefined ? undefined : channel.announce(role)), [channel, role]);
}

/** Whether this window has a channel for its scope. */
export function useWindowChannelAvailable(): boolean {
  return useWindowChannel(useWindowScope())?.available ?? false;
}

/** The roles other windows of the scope hold: empty where there is no channel. */
export function useOtherWindowRoles(): ReadonlySet<WindowRole> {
  const channel = useWindowChannel(useWindowScope());
  return useSyncExternalStore(channel?.others.subscribe ?? NO_CHANGE, () => channel?.others.getState() ?? NO_ROLES);
}
