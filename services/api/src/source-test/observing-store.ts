import type { AppStore } from '../app-store.js';
import type { UsabilityRecord } from './usability.js';

/** The store that startup, the API check and the scheduled first contact write checks to: each stored check also moves the record of what the checks showed and what is cheap. */
export function observingStoreOf(store: AppStore, record: UsabilityRecord): AppStore {
  return {
    ...store,
    recordSourceCheck: async (check) => {
      await store.recordSourceCheck(check);
      record.observe(check.report);
    },
  };
}
