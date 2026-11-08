import type { Coordinator, ReadAccessRequest, ReadAdmission, ReadLease } from './seams.js';

export interface Timer {
  cancel(): void;
}

export type SetTimer = (run: () => void, ms: number) => Timer;

export interface ReadSlotsOptions {
  /** Schedules the end of a wait and the expiry of a lease. */
  readonly setTimer?: SetTimer;
  /** Told when a lease frees itself because it was never released. */
  readonly onExpired?: (sourceId: string) => void;
}

export interface ReadSlots extends Coordinator {
  /** The slots held and the reads waiting, by source and by user on a source; an entry exists only while it holds or waits for a slot. */
  inspect(): { readonly sources: ReadonlyMap<string, PoolCounts>; readonly users: ReadonlyMap<string, PoolCounts> };
}

export interface PoolCounts {
  readonly held: number;
  readonly waiting: number;
}

interface Waiter {
  readonly limit: number;
  readonly grant: () => void;
}

interface Pool {
  held: number;
  readonly waiters: Waiter[];
}

const realTimer: SetTimer = (run, ms) => {
  const handle = setTimeout(run, ms);
  handle.unref();
  return { cancel: () => clearTimeout(handle) };
};

const BUSY: ReadAdmission = { status: 'busy' };
const CANCELLED: ReadAdmission = { status: 'cancelled' };

/**
 * The in-process read slots of one API copy: a user's slot on the source, then the source's slot, both within one wait. Waiters are served in the order they came; a read refused as busy
 * gives back the user's slot it took; a lease frees both slots on its first release, or by itself after its time to live.
 */
export function createReadSlots(options: ReadSlotsOptions = {}): ReadSlots {
  const setTimer = options.setTimer ?? realTimer;
  const sources = new Map<string, Pool>();
  const users = new Map<string, Pool>();

  const poolOf = (pools: Map<string, Pool>, key: string): Pool => {
    const held = pools.get(key);
    if (held !== undefined) return held;
    const created: Pool = { held: 0, waiters: [] };
    pools.set(key, created);
    return created;
  };

  const forget = (pools: Map<string, Pool>, key: string, pool: Pool): void => {
    if (pool.held === 0 && pool.waiters.length === 0 && pools.get(key) === pool) pools.delete(key);
  };

  const serve = (pool: Pool): void => {
    for (let next = pool.waiters[0]; next !== undefined && pool.held < next.limit; next = pool.waiters[0]) {
      pool.waiters.shift();
      pool.held += 1;
      next.grant();
    }
  };

  const give = (pools: Map<string, Pool>, key: string, pool: Pool): void => {
    pool.held -= 1;
    serve(pool);
    forget(pools, key, pool);
  };

  /** Takes a slot at once when one is free and nobody waits before this read, else queues the read; `granted` runs when the slot is taken. */
  const take = (pool: Pool, limit: number, granted: () => void): Waiter | undefined => {
    if (pool.waiters.length === 0 && pool.held < limit) {
      pool.held += 1;
      granted();
      return undefined;
    }
    const waiter: Waiter = { limit, grant: granted };
    pool.waiters.push(waiter);
    return waiter;
  };

  const leaseOf = (request: ReadAccessRequest, userKey: string, user: Pool, source: Pool): ReadLease => {
    let freed = false;
    const free = (): void => {
      if (freed) return;
      freed = true;
      expiry.cancel();
      give(sources, request.sourceId, source);
      give(users, userKey, user);
    };
    const expiry = setTimer(() => {
      if (freed) return;
      options.onExpired?.(request.sourceId);
      free();
    }, request.leaseTtlMs);
    return {
      release: () => {
        free();
        return Promise.resolve();
      },
    };
  };

  return {
    acquireRead(request) {
      const { limits, sourceId } = request;
      const userKey = JSON.stringify([sourceId, request.principal.id]);
      const { signal } = request;
      if (signal?.aborted === true) return Promise.resolve(CANCELLED);
      const user = poolOf(users, userKey);
      return new Promise<ReadAdmission>((resolve) => {
        let waiting: { readonly pool: Pool; readonly waiter: Waiter } | undefined;
        let holdsUser = false;
        let settled = false;
        const settle = (admission: ReadAdmission): void => {
          settled = true;
          wait.cancel();
          signal?.removeEventListener('abort', onAbort);
          resolve(admission);
        };
        // the source's pool is looked up when the user's slot is held, never before, so it is the one in the table and not one dropped while this read waited
        const onSource = (source: Pool) => (): void => {
          waiting = undefined;
          if (settled) {
            give(sources, sourceId, source);
            give(users, userKey, user);
            return;
          }
          settle({ status: 'granted', lease: leaseOf(request, userKey, user, source) });
        };
        const onUser = (): void => {
          waiting = undefined;
          holdsUser = true;
          if (settled) {
            give(users, userKey, user);
            return;
          }
          const source = poolOf(sources, sourceId);
          const queued = take(source, limits.sourceConcurrency, onSource(source));
          if (queued !== undefined) waiting = { pool: source, waiter: queued };
        };
        // ends a read that is still queued, without an admission: out of the queue it stands in, the user's slot given back if it holds one
        const leave = (admission: ReadAdmission): void => {
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          if (waiting !== undefined) {
            const { pool, waiter } = waiting;
            pool.waiters.splice(pool.waiters.indexOf(waiter), 1);
            // the waiter that leaves may have been the head of the queue, holding back one behind it that a free slot can take
            serve(pool);
            forget(pool === user ? users : sources, pool === user ? userKey : sourceId, pool);
          }
          if (holdsUser) give(users, userKey, user);
          resolve(admission);
        };
        const wait = setTimer(() => {
          if (!settled) leave(BUSY);
        }, limits.queueWaitMs);
        function onAbort(): void {
          if (settled) return;
          wait.cancel();
          leave(CANCELLED);
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        const queued = take(user, limits.userConcurrency, onUser);
        if (queued !== undefined) waiting = { pool: user, waiter: queued };
      });
    },
    inspect() {
      const counts = (pools: Map<string, Pool>): ReadonlyMap<string, PoolCounts> => new Map([...pools].map(([key, pool]) => [key, { held: pool.held, waiting: pool.waiters.length }]));
      return { sources: counts(sources), users: counts(users) };
    },
  };
}
