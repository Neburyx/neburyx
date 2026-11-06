import { AppError } from '../errors.js';
import { schemaIndexesItemSchema, SCHEMA_INDEXES_ID } from './templates/schema-indexes.js';
import type { GatePage, IndexNeed, IndexSnapshot, SourceAllowlist } from './types.js';

/** The form in which a property has an ONLINE single-property index: `value` for a RANGE index or a constraint (any value, including an integer), `text` for a TEXT index (strings only). */
export type OnlineForm = 'value' | 'text';

const SINGLE_NODE_INDEX_ONLINE = 'ONLINE';

export function onlineFormOf(snapshot: IndexSnapshot, label: string, property: string): OnlineForm | undefined {
  const online = snapshot.entries.filter((entry) => entry.entityType === 'NODE' && entry.name === label && entry.property === property && entry.single && entry.state === SINGLE_NODE_INDEX_ONLINE);
  if (online.some((entry) => entry.type === 'RANGE')) return 'value';
  return online.some((entry) => entry.type === 'TEXT') ? 'text' : undefined;
}

/** Whether the index of a need is there: a need that asks for `value` is met by a RANGE index or a constraint only, one that accepts any by a TEXT index too. */
export function isMet(snapshot: IndexSnapshot, need: IndexNeed, allowlist: SourceAllowlist): boolean {
  const label = allowlist.entityLabels.get(need.entityType);
  if (label === undefined) return true;
  const form = onlineFormOf(snapshot, label, need.property);
  return form !== undefined && (need.accepts === 'any' || form === 'value');
}

export interface SchemaRead {
  (request: { readonly traceId: string; readonly sourceId: string; readonly templateId: string; readonly params: unknown; readonly limit: number }): Promise<GatePage>;
}

const ONE_ROW = 1;

/**
 * The indexes of a source as they are now, read through the system runner. `'unverified'` when the login may not list indexes (the source refuses the read), the one case TAS §8.3
 * leaves unprotected. Any other failure of the read (a timeout, a busy or unavailable source, an answer that cannot be read or is truncated) is an error and no data read follows.
 */
export async function readIndexSnapshot(run: SchemaRead, request: { readonly traceId: string; readonly sourceId: string }): Promise<IndexSnapshot | 'unverified'> {
  let page: GatePage;
  try {
    page = await run({ traceId: request.traceId, sourceId: request.sourceId, templateId: SCHEMA_INDEXES_ID, params: {}, limit: ONE_ROW });
  } catch (error) {
    if (error instanceof AppError && error.code === 'SOURCE_UNAVAILABLE' && error.reason === 'refused') return 'unverified';
    throw error;
  }
  const parsed = schemaIndexesItemSchema.safeParse(page.items[0]);
  if (!parsed.success || parsed.data.truncated) throw new AppError('INTERNAL_ERROR', undefined, 'read-failed');
  return { sourceId: request.sourceId, entries: parsed.data.indexes };
}
