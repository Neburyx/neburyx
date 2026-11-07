import type { DegreePreview } from '@neburyx/contracts';

/** Hypotheses: a preview stays valid for five minutes, and the cache keeps the 5,000 most recently used. */
export const DEFAULT_CACHE_LIFETIME_MS = 5 * 60 * 1000;
export const DEFAULT_CACHE_ENTRIES = 5000;

export interface DegreeCacheOptions {
  readonly lifetimeMs?: number;
  readonly maxEntries?: number;
  readonly clock?: () => number;
}

export interface DegreeCacheKey {
  readonly sourceId: string;
  readonly configHash: string;
  readonly principalId: string;
  readonly entityType: string;
  readonly stableId: string;
  readonly mask: boolean;
  readonly verdictRevision: number;
}

export interface DegreeCache {
  get(key: DegreeCacheKey): DegreePreview | undefined;
  set(key: DegreeCacheKey, preview: DegreePreview): void;
  size(): number;
}

interface Entry {
  readonly preview: DegreePreview;
  readonly storedAt: number;
}

const textOf = (key: DegreeCacheKey): string => JSON.stringify([key.sourceId, key.configHash, key.principalId, key.entityType, key.stableId, key.mask, key.verdictRevision]);

/**
 * An in-memory cache of answered previews, in the order of last use. It holds counts, their quality and warnings, never a property value. Every field of the key matters: another person, source, node,
 * mapping, mask setting or degree verdict is another entry, so a masked answer is never served to an unmasked request.
 */
export function createDegreeCache(options: DegreeCacheOptions = {}): DegreeCache {
  const lifetimeMs = options.lifetimeMs ?? DEFAULT_CACHE_LIFETIME_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_CACHE_ENTRIES;
  const clock = options.clock ?? Date.now;
  const entries = new Map<string, Entry>();
  return {
    get(key) {
      const text = textOf(key);
      const found = entries.get(text);
      if (found === undefined) return undefined;
      entries.delete(text);
      if (clock() - found.storedAt >= lifetimeMs) return undefined;
      entries.set(text, found);
      return found.preview;
    },
    set(key, preview) {
      const text = textOf(key);
      entries.delete(text);
      entries.set(text, { preview, storedAt: clock() });
      for (const oldest of entries.keys()) {
        if (entries.size <= maxEntries) break;
        entries.delete(oldest);
      }
    },
    size: () => entries.size,
  };
}
