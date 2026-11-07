import { AppError } from '../errors.js';
import { schemaIndexesItemSchema, SCHEMA_INDEXES_ID } from './templates/schema-indexes.js';
import type { GatePage, IndexNeed, IndexSnapshot, RelationshipIndexNeed, SourceAllowlist } from './types.js';

/** The form in which a property has an ONLINE single-property index: `value` for a RANGE index or a constraint (any value, including an integer), `text` for a TEXT index (strings only). */
export type OnlineForm = 'value' | 'text';

/** Why a property has no online index: none is there (or none of the kind asked for), the one there is still being built, or it failed. */
export type IndexGap = 'index-unavailable' | 'index-building' | 'index-failed';

/** The index of one property as a snapshot shows it: the form it is served in, or why it cannot be. */
export type PropertyIndex = { readonly form: OnlineForm } | { readonly gap: IndexGap };

const ONLINE = 'ONLINE';
const POPULATING = 'POPULATING';
const FAILED = 'FAILED';

/**
 * Of the single-property indexes that could serve the property (RANGE ones only when `accepts` is `value`), the form of an online one; else `index-building` when one is being
 * built, `index-failed` when one failed, and `index-unavailable` when there is none.
 */
export function propertyIndexOf(snapshot: IndexSnapshot, name: string, property: string, kind: 'NODE' | 'RELATIONSHIP' = 'NODE', accepts: 'value' | 'any' = 'any'): PropertyIndex {
  const serving = snapshot.entries.filter((entry) => entry.entityType === kind && entry.name === name && entry.property === property && entry.single && (accepts === 'any' || entry.type === 'RANGE'));
  const online = serving.filter((entry) => entry.state === ONLINE);
  if (online.some((entry) => entry.type === 'RANGE')) return { form: 'value' };
  if (online.some((entry) => entry.type === 'TEXT')) return { form: 'text' };
  if (serving.some((entry) => entry.state === POPULATING)) return { gap: 'index-building' };
  return { gap: serving.some((entry) => entry.state === FAILED) ? 'index-failed' : 'index-unavailable' };
}

const gapIn = (index: PropertyIndex): IndexGap | undefined => ('gap' in index ? index.gap : undefined);

/** Why the index of a need is not there, or undefined when it is: a need that asks for `value` is met by a RANGE index or a constraint only, one that accepts any by a TEXT index too. */
export function gapOf(snapshot: IndexSnapshot, need: IndexNeed | RelationshipIndexNeed, allowlist: SourceAllowlist): IndexGap | undefined {
  if ('relationshipType' in need) return gapIn(propertyIndexOf(snapshot, need.relationshipType, need.property, 'RELATIONSHIP', need.accepts));
  const label = allowlist.entityLabels.get(need.entityType);
  return label === undefined ? undefined : gapIn(propertyIndexOf(snapshot, label, need.property, 'NODE', need.accepts));
}

/** A gap that waiting does not cure comes before one that it does, so a refusal of several unmet needs never says to retry what cannot change by itself. */
const GAP_ORDER: readonly IndexGap[] = ['index-failed', 'index-unavailable', 'index-building'];

export function worstGapOf(gaps: readonly IndexGap[]): IndexGap | undefined {
  return GAP_ORDER.find((gap) => gaps.includes(gap));
}

export interface SchemaRead {
  (request: { readonly traceId: string; readonly sourceId: string; readonly templateId: string; readonly params: unknown; readonly limit: number }): Promise<GatePage>;
}

const ONE_ROW = 1;

/**
 * The indexes of a source as they are now, read through the system runner. `'unverified'` when the login may not list indexes (the source refuses the read), the one case left
 * unprotected. Any other failure of the read is an error and no data read follows: a timeout, a busy or unavailable source, or an answer that cannot be read or is truncated
 * (`SOURCE_UNAVAILABLE` tagged `index-list-unreadable`).
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
  // a list that is not whole cannot show that an index is missing, and a read made without knowing could be a scan
  if (!parsed.success || parsed.data.truncated) throw new AppError('SOURCE_UNAVAILABLE', undefined, 'index-list-unreadable');
  return { sourceId: request.sourceId, entries: parsed.data.indexes };
}
