import type { DegreePreview } from '@neburyx/contracts';

/** Hypotheses: a preview is served to a preview request for five minutes after it was read, and the cache keeps the 5,000 most recently used. */
export const DEFAULT_CACHE_LIFETIME_MS = 5 * 60 * 1000;
export const DEFAULT_CACHE_ENTRIES = 5000;

/**
 * A hypothesis: coverage counts a preview while it is used at least every five minutes, but never for more than an hour after it was read. The coverage line is a sum of previews, so one that kept
 * being used must not outlive a normal session while the source changes underneath it.
 */
export const DEFAULT_COVERAGE_MAX_AGE_MS = 60 * 60 * 1000;

export interface DegreeCacheOptions {
  readonly lifetimeMs?: number;
  readonly coverageMaxAgeMs?: number;
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
  /** The preview for a preview request: served only within the lifetime of its read, whatever its use by coverage. */
  get(key: DegreeCacheKey): DegreePreview | undefined;
  /** The preview for a coverage read: counted while it is used within the lifetime and not older than the maximum age of its read; a use renews it. */
  getForCoverage(key: DegreeCacheKey): DegreePreview | undefined;
  set(key: DegreeCacheKey, preview: DegreePreview): void;
  size(): number;
}

interface Entry {
  readonly preview: DegreePreview;
  readonly storedAt: number;
  coverageUsedAt: number;
}

const textOf = (key: DegreeCacheKey): string => JSON.stringify([key.sourceId, key.configHash, key.principalId, key.entityType, key.stableId, key.mask, key.verdictRevision]);

/**
 * An in-memory cache of answered previews, in the order of last use. It holds counts, their quality and warnings, never a property value. Every field of the key matters: another person, source, node,
 * mapping, mask setting or degree verdict is another entry, so a masked answer is never served to an unmasked request.
 */
export function createDegreeCache(options: DegreeCacheOptions = {}): DegreeCache {
  const lifetimeMs = options.lifetimeMs ?? DEFAULT_CACHE_LIFETIME_MS;
  const coverageMaxAgeMs = options.coverageMaxAgeMs ?? DEFAULT_COVERAGE_MAX_AGE_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_CACHE_ENTRIES;
  const clock = options.clock ?? Date.now;
  const entries = new Map<string, Entry>();
  const touch = (text: string, entry: Entry): void => {
    entries.delete(text);
    entries.set(text, entry);
  };
  return {
    get(key) {
      const text = textOf(key);
      const found = entries.get(text);
      if (found === undefined || clock() - found.storedAt >= lifetimeMs) return undefined;
      touch(text, found);
      return found.preview;
    },
    getForCoverage(key) {
      const text = textOf(key);
      const found = entries.get(text);
      if (found === undefined) return undefined;
      const now = clock();
      if (now - found.storedAt >= coverageMaxAgeMs || now - found.coverageUsedAt >= lifetimeMs) {
        entries.delete(text);
        return undefined;
      }
      found.coverageUsedAt = now;
      touch(text, found);
      return found.preview;
    },
    set(key, preview) {
      const text = textOf(key);
      const now = clock();
      entries.delete(text);
      entries.set(text, { preview, storedAt: now, coverageUsedAt: now });
      for (const oldest of entries.keys()) {
        if (entries.size <= maxEntries) break;
        entries.delete(oldest);
      }
    },
    size: () => entries.size,
  };
}
