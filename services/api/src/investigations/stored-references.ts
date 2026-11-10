import { MAX_TITLE_LENGTH, type LayoutDocument, type QueryContextDocument } from '@neburyx/contracts';
import { isKeyed, type EntityModel, type MappingModel, type SourceModel } from '../mapping/model.js';
import type { ReferenceKeys } from '../reference/keys.js';
import { looksLikeToken, makeToken, readToken } from '../reference/token.js';
import { decodeStored, encodeStored } from '../reference/stored-text.js';
import { isStorableText } from '../reference/well-formed.js';

type Ref = { readonly t: string; readonly id: string };
type EdgeEnds = { readonly t: string; readonly from: Ref; readonly to: Ref };

export interface StoredReferences {
  /** The reference a stored entity ID is shown as: the ID as it was sent, decoded from its stored form; a token when the type is keyed now; and the value of a token that a type no longer keyed was stored under. */
  entityId(sourceId: string, entityType: string, stableId: string): string;
  /** The text to store for a reference the API returned or a person sent: the token of a keyed type as it is, any other ID in a form PostgreSQL can hold (see `encodeStored`). */
  toStored(sourceId: string, entityType: string, reference: string): string;
  /**
   * Every text an investigation of this reference may have been stored under, in the order to look: the text it is stored under now, and the other form it may have from before the mapping changed: for a keyed
   * type the raw value, and for a type that is no longer keyed the token. A value that is itself a token of this place, or that could never have been stored as text, is not a second candidate.
   */
  storedForms(sourceId: string, entityType: string, reference: string): readonly string[];
  /** The raw value behind a stored ID of a keyed type (a token is read, a raw value is itself); undefined when the type is not keyed or the source is not in the configuration. */
  rawValue(sourceId: string, entityType: string, stableId: string): string | undefined;
  /** Refuses a reference of a keyed type that is not exactly a token this deployment made for this source and type; any other type is accepted as it is. */
  authenticate(sourceId: string, entityType: string, stableId: string): void;
  /** The layout as it is stored: every ID in the form `toStored` gives, a reference of a keyed type refused unless it is a token of this deployment (`INVALID_REQUEST`). */
  storedLayout(sourceId: string, document: LayoutDocument): LayoutDocument;
  /** The query context as it is stored, as `storedLayout`, and without a filter on a personal-data property. */
  storedQueryContext(sourceId: string, document: QueryContextDocument): QueryContextDocument;
  layout(sourceId: string, document: LayoutDocument): LayoutDocument;
  queryContext(sourceId: string, document: QueryContextDocument): QueryContextDocument;
  /** The title of a stored investigation as it may be shown: a generated title that holds a keyed value becomes the entity type's display name; a title the person wrote is theirs and stays. */
  title(row: { readonly sourceId: string; readonly title: string; readonly startingEntityType: string | null; readonly startingStableId: string | null }): string;
}

/**
 * Converts the entity IDs a stored investigation holds to the references the API returns now. A type the mapping keys today may have been stored with raw IDs when it was not keyed, and
 * nothing of that reaches a response: the conversion is a local computation over the person's own record, with no read of the source and no write back. A source that is no longer in the
 * configuration has no mapping to say which types are keyed, so it is shown as stored.
 */
export function createStoredReferences(mapping: MappingModel, keys: ReferenceKeys): StoredReferences {
  const sourceOf = (sourceId: string): SourceModel | undefined => mapping.sources.find((candidate) => candidate.id === sourceId);
  const typeOf = (sourceId: string, entityType: string): EntityModel | undefined => sourceOf(sourceId)?.entities.find((entity) => entity.type === entityType);
  const keyedType = (sourceId: string, entityType: string): EntityModel | undefined => {
    const type = typeOf(sourceId, entityType);
    return type !== undefined && isKeyed(type) ? type : undefined;
  };

  const valueOfToken = (sourceId: string, entityType: string, text: string): string | undefined => {
    if (!looksLikeToken(text)) return undefined;
    try {
      return readToken(keys, { sourceId, entityType }, text);
    } catch {
      return undefined;
    }
  };

  const rawValue = (sourceId: string, entityType: string, stored: string): string | undefined => {
    if (keyedType(sourceId, entityType) === undefined) return undefined;
    const decoded = decodeStored(stored);
    return valueOfToken(sourceId, entityType, decoded) ?? decoded;
  };

  const entityId = (sourceId: string, entityType: string, stored: string): string => {
    const decoded = decodeStored(stored);
    if (typeOf(sourceId, entityType) === undefined) return decoded;
    if (keyedType(sourceId, entityType) !== undefined) return makeToken(keys, { sourceId, entityType }, valueOfToken(sourceId, entityType, decoded) ?? decoded);
    return valueOfToken(sourceId, entityType, decoded) ?? decoded;
  };

  const storedId = (sourceId: string, entityType: string, reference: string): string => {
    if (keyedType(sourceId, entityType) === undefined) return encodeStored(reference);
    readToken(keys, { sourceId, entityType }, reference);
    return reference;
  };
  const storedRefs = (sourceId: string, list: readonly Ref[]): Ref[] => list.map((ref) => ({ ...ref, id: storedId(sourceId, ref.t, ref.id) }));
  const storedEdges = <E extends EdgeEnds>(sourceId: string, list: readonly E[]): E[] => list.map((edge) => ({ ...edge, from: { ...edge.from, id: storedId(sourceId, edge.from.t, edge.from.id) }, to: { ...edge.to, id: storedId(sourceId, edge.to.t, edge.to.id) } }));

  const refs = (sourceId: string, list: readonly Ref[]): Ref[] => list.map((ref) => ({ ...ref, id: entityId(sourceId, ref.t, ref.id) }));
  const edges = <E extends EdgeEnds>(sourceId: string, list: readonly E[]): E[] => list.map((edge) => ({ ...edge, from: { ...edge.from, id: entityId(sourceId, edge.from.t, edge.from.id) }, to: { ...edge.to, id: entityId(sourceId, edge.to.t, edge.to.id) } }));

  /** The keys of every personal-data property of the source: a stored property filter on one is not returned, since its values are personal data and the type it belongs to is not stored. */
  const personalKeys = (sourceId: string): ReadonlySet<string> => new Set(sourceOf(sourceId)?.entities.flatMap((entity) => entity.pii) ?? []);

  /** Whether a title is the generated `<name> <value>` of a keyed entity, whatever the type was called when it was made: it ends in the value, or, cut at the limit, in the front of it. */
  const generatedFrom = (title: string, raw: string): boolean => {
    if (title.endsWith(` ${raw}`)) return true;
    // a generated title is cut only at the limit, so a shorter title that ends in an ellipsis was written by a person
    if (!title.endsWith('…') || Array.from(title).length !== MAX_TITLE_LENGTH) return false;
    const body = title.slice(0, -1);
    for (let at = body.indexOf(' ') + 1; at > 0 && at < body.length; at = body.indexOf(' ', at) + 1) {
      if (raw.startsWith(body.slice(at))) return true;
    }
    return false;
  };

  return {
    entityId,
    rawValue,
    toStored(sourceId, entityType, reference) {
      return keyedType(sourceId, entityType) === undefined ? encodeStored(reference) : reference;
    },
    storedForms(sourceId, entityType, reference) {
      if (typeOf(sourceId, entityType) === undefined) return [encodeStored(reference)];
      if (keyedType(sourceId, entityType) !== undefined) {
        const raw = valueOfToken(sourceId, entityType, reference);
        return raw === undefined || valueOfToken(sourceId, entityType, raw) !== undefined ? [reference] : [reference, encodeStored(raw)];
      }
      try {
        return [encodeStored(reference), makeToken(keys, { sourceId, entityType }, reference)];
      } catch {
        return [encodeStored(reference)];
      }
    },
    authenticate(sourceId, entityType, stableId) {
      if (keyedType(sourceId, entityType) !== undefined) readToken(keys, { sourceId, entityType }, stableId);
    },
    storedLayout(sourceId, document) {
      return {
        ...document,
        nodes: document.nodes.map((node) => ({ ...node, id: storedId(sourceId, node.t, node.id) })),
        edges: storedEdges(sourceId, document.edges),
        groups: document.groups.map((group) => ({ ...group, members: storedRefs(sourceId, group.members) })),
      };
    },
    storedQueryContext(sourceId, document) {
      return {
        ...document,
        loaded: { nodes: storedRefs(sourceId, document.loaded.nodes), edges: storedEdges(sourceId, document.loaded.edges) },
        expansions: document.expansions.map((expansion) => ({ ...expansion, from: { ...expansion.from, id: storedId(sourceId, expansion.from.t, expansion.from.id) } })),
        filters: { ...document.filters, properties: document.filters.properties.filter((filter) => !personalKeys(sourceId).has(filter.key)) },
      };
    },
    layout(sourceId, document) {
      return {
        ...document,
        nodes: document.nodes.map((node) => ({ ...node, id: entityId(sourceId, node.t, node.id) })),
        edges: edges(sourceId, document.edges),
        groups: document.groups.map((group) => ({ ...group, members: refs(sourceId, group.members) })),
      };
    },
    queryContext(sourceId, document) {
      return {
        ...document,
        loaded: { nodes: refs(sourceId, document.loaded.nodes), edges: edges(sourceId, document.loaded.edges) },
        expansions: document.expansions.map((expansion) => ({ ...expansion, from: { ...expansion.from, id: entityId(sourceId, expansion.from.t, expansion.from.id) } })),
        filters: { ...document.filters, properties: document.filters.properties.filter((filter) => !personalKeys(sourceId).has(filter.key)) },
      };
    },
    title(row) {
      if (row.startingEntityType === null || row.startingStableId === null) return row.title;
      const type = keyedType(row.sourceId, row.startingEntityType);
      const raw = rawValue(row.sourceId, row.startingEntityType, row.startingStableId);
      if (type === undefined || raw === undefined) return row.title;
      const name = type.display.name ?? type.label;
      return generatedFrom(row.title, raw) ? name : row.title;
    },
  };
}
