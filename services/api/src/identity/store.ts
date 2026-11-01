import { createPool } from '../db/pool.js';
import { readIdentity, seedFirstStart } from '../db/identity-repository.js';
import { toStartError } from './errors.js';
import type { Identity } from './identity.js';

export interface IdentityStore {
  initialize(): Promise<void>;
  current(): Promise<Identity>;
  close(): Promise<void>;
}

export function createIdentityStore(url: string, onConnectionError: () => void, connectionTimeoutMs?: number): IdentityStore {
  const pool = createPool(url, onConnectionError, connectionTimeoutMs);
  return {
    async initialize(): Promise<void> {
      try {
        await seedFirstStart(pool);
      } catch (error) {
        throw toStartError(error);
      }
    },
    current: () => readIdentity(pool),
    close: () => pool.end(),
  };
}
