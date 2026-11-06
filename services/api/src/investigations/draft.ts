import { createHash } from 'node:crypto';
import type { LayoutDocument, QueryContextDocument } from '@neburyx/contracts';
import { canonicalText } from '../mapping/hash.js';

/** The policy version Community's gate and counts carry: it has none. */
export const COMMUNITY_POLICY_VERSION = 'none';

const SCHEMA_VERSION = 1;
const DEFAULT_LAYOUT = 'force';

export interface DraftDocuments {
  readonly layout: LayoutDocument;
  readonly queryContext: QueryContextDocument;
}

/** What a draft holds when an investigation is opened: the starting entity, and no relationship, group, expansion or filter. */
export function initialDraftDocuments(entity: { readonly entityType: string; readonly stableId: string }): DraftDocuments {
  return {
    layout: { schemaVersion: SCHEMA_VERSION, layout: DEFAULT_LAYOUT, nodes: [{ t: entity.entityType, id: entity.stableId, pinned: false, hidden: false, groupId: null }], edges: [], groups: [] },
    queryContext: {
      schemaVersion: SCHEMA_VERSION,
      loaded: { nodes: [{ t: entity.entityType, id: entity.stableId }], edges: [] },
      expansions: [],
      filters: { entityTypes: [], relTypes: [], time: null, properties: [] },
    },
  };
}

/** The hash of everything the Save dialog would snapshot: the layout, the query context, the notes and the AI notes. */
export function contentHashOf(documents: DraftDocuments, notes: string | null = null, aiNotes: unknown = null): string {
  return createHash('sha256').update(canonicalText([documents.layout, documents.queryContext, notes, aiNotes])).digest('hex');
}

const ELLIPSIS = '…';

/** `<display name> <stable ID>`, cut at the limit with a final "…" when it is longer, so the cut shows. It never holds a value of a personal-data property. */
export function defaultTitle(displayName: string, stableId: string, limit: number): string {
  const whole = Array.from(`${displayName} ${stableId}`);
  return whole.length <= limit ? whole.join('') : `${whole.slice(0, limit - 1).join('')}${ELLIPSIS}`;
}
