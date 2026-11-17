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
  /** The share of each pool that AI reads may hold at most, above 0 and up to 1; absent means they may hold all of it. A pool always lets one AI read hold a slot. */
  readonly aiShare?: number;
}

export interface ReadSlots extends Coordinator {
  /** The slots held and the reads waiting, by source and by user on a source; an entry exists only while it holds or waits for a slot. */
  inspect(): { readonly sources: ReadonlyMap<string, PoolCounts>; readonly users: ReadonlyMap<string, PoolCounts> };
  /** Of those, how many are AI reads, with the same entries as `inspect()`. */
  inspectAi(): { readonly sources: ReadonlyMap<string, AiPoolCounts>; readonly users: ReadonlyMap<string, AiPoolCounts> };
}

interface PoolCounts {
  readonly held: number;
  readonly waiting: number;
}

interface AiPoolCounts {
  readonly aiHeld: number;
  readonly aiWaiting: number;
}

interface Waiter {
  readonly limit: number;
  readonly ai: boolean;
  readonly grant: () => void;
}

interface Pool {
  held: number;
  aiHeld: number;
  readonly waiters: Waiter[];
}

export const realTimer: SetTimer = (run, ms) => {
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
  const aiShare = options.aiShare ?? 1;
  const aiLimitOf = (limit: number): number => Math.max(1, Math.floor(aiShare * limit));
  const sources = new Map<string, Pool>();
  const users = new Map<string, Pool>();

  const poolOf = (pools: Map<string, Pool>, key: string): Pool => {
    const held = pools.get(key);
    if (held !== undefined) return held;
    const created: Pool = { held: 0, aiHeld: 0, waiters: [] };
    pools.set(key, created);
    return created;
  };

  const forget = (pools: Map<string, Pool>, key: string, pool: Pool): void => {
    if (pool.held === 0 && pool.waiters.length === 0 && pools.get(key) === pool) pools.delete(key);
  };

  /** An AI read waits when its pool already holds its share of AI reads, even if a slot is free. */
  const canHold = (pool: Pool, waiter: Pick<Waiter, 'limit' | 'ai'>): boolean => pool.held < waiter.limit && (!waiter.ai || pool.aiHeld < aiLimitOf(waiter.limit));

  const hold = (pool: Pool, ai: boolean): void => {
    pool.held += 1;
    if (ai) pool.aiHeld += 1;
  };

  /** Serves the waiters in the order they came, skipping an AI read that is over its share so that it never holds up a manual read behind it. */
  const serve = (pool: Pool): void => {
    for (let index = pool.waiters.findIndex((waiter) => canHold(pool, waiter)); index !== -1; index = pool.waiters.findIndex((waiter) => canHold(pool, waiter))) {
      const [next] = pool.waiters.splice(index, 1);
      if (next === undefined) return;
      hold(pool, next.ai);
      next.grant();
    }
  };

  const give = (pools: Map<string, Pool>, key: string, pool: Pool, ai: boolean): void => {
    pool.held -= 1;
    if (ai) pool.aiHeld -= 1;
    serve(pool);
    forget(pools, key, pool);
  };

  /** Takes a slot at once when this read may hold one and no waiter that may hold one is ahead of it, else queues the read; `granted` runs when the slot is taken. */
  const take = (pool: Pool, limit: number, ai: boolean, granted: () => void): Waiter | undefined => {
    if (canHold(pool, { limit, ai }) && !pool.waiters.some((waiter) => canHold(pool, waiter))) {
      hold(pool, ai);
      granted();
      return undefined;
    }
    const waiter: Waiter = { limit, ai, grant: granted };
    pool.waiters.push(waiter);
    return waiter;
  };

  const leaseOf = (request: ReadAccessRequest, userKey: string, user: Pool, source: Pool, ai: boolean): ReadLease => {
    let freed = false;
    const free = (): void => {
      if (freed) return;
      freed = true;
      expiry.cancel();
      give(sources, request.sourceId, source, ai);
      give(users, userKey, user, ai);
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
      const ai = request.origin === 'ai';
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
            give(sources, sourceId, source, ai);
            give(users, userKey, user, ai);
            return;
          }
          settle({ status: 'granted', lease: leaseOf(request, userKey, user, source, ai) });
        };
        const onUser = (): void => {
          waiting = undefined;
          holdsUser = true;
          if (settled) {
            give(users, userKey, user, ai);
            return;
          }
          const source = poolOf(sources, sourceId);
          const queued = take(source, limits.sourceConcurrency, ai, onSource(source));
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
          if (holdsUser) give(users, userKey, user, ai);
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
        const queued = take(user, limits.userConcurrency, ai, onUser);
        if (queued !== undefined) waiting = { pool: user, waiter: queued };
      });
    },
    inspect() {
      const counts = (pools: Map<string, Pool>): ReadonlyMap<string, PoolCounts> => new Map([...pools].map(([key, pool]) => [key, { held: pool.held, waiting: pool.waiters.length }]));
      return { sources: counts(sources), users: counts(users) };
    },
    inspectAi() {
      const counts = (pools: Map<string, Pool>): ReadonlyMap<string, AiPoolCounts> => new Map([...pools].map(([key, pool]) => [key, { aiHeld: pool.aiHeld, aiWaiting: pool.waiters.filter((waiter) => waiter.ai).length }]));
      return { sources: counts(sources), users: counts(users) };
    },
  };
}
