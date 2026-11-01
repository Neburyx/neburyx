import type { Identity } from '../identity/identity.js';
import type { IdentityStore } from '../identity/store.js';

export const LOCAL_IDENTITY: Identity = {
  principal: { id: '0192f000-0000-7000-8000-000000000001', displayName: 'Local workspace', role: 'administrator' },
  edition: 'community',
  identityMode: 'none',
};

export function memoryIdentityStore(): IdentityStore {
  return {
    initialize: () => Promise.resolve(),
    current: () => Promise.resolve(LOCAL_IDENTITY),
    close: () => Promise.resolve(),
  };
}
