/**
 * The most entities, and the most relationships, one export holds. This is the draft's soft target; the figure that replaces it is the largest count whose full read finishes within half the request
 * deadline on the laptop target, measured on the demo data and written here with the figures when it is. Above the limit an export is refused, never cut.
 */
export const MAX_EXPORT_ENTITIES = 300;
export const MAX_EXPORT_RELATIONSHIPS = 300;

/** Pending rows and temporary files older than this are the leftovers of a call that never finished. */
export const STALE_EXPORT_MS = 15 * 60_000;
