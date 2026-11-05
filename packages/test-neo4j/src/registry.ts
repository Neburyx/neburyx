/** What a run has started and not yet stopped: a server (with its database, logins and roles) or a forwarder. */
const open = new Set<() => Promise<void>>();

/** Records something to stop; gives back the function that forgets it, to call once it has stopped. */
export function registerOpen(stop: () => Promise<void>): () => void {
  open.add(stop);
  return () => void open.delete(stop);
}

/**
 * Stops everything still open, each exactly once more than it was stopped by its owner (a stop is safe to repeat), and reports every failure together.
 * A hook that starts several servers at once calls this when one start fails, and a test file calls it when it ends, so that nothing a failed start made is left behind.
 */
export async function stopAllStarted(): Promise<void> {
  const failures: unknown[] = [];
  for (const stop of [...open]) {
    try {
      await stop();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'a cleanup step failed');
}
