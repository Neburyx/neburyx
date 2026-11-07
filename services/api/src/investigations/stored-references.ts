import { MAX_TITLE_LENGTH, type LayoutDocument, type QueryContextDocument } from '@neburyx/contracts';
import { isKeyed, type EntityModel, type MappingModel, type SourceModel } from '../mapping/model.js';
import type { ReferenceKeys } from '../reference/keys.js';
import { looksLikeToken, makeToken, readToken } from '../reference/token.js';
import { decodeStored, encodeStored } from '../reference/stored-text.js';
import { isStorableText } from '../reference/well-formed.js';

type Ref = { readonly t: string; readonly id: string };
type EdgeEnds = { readonly t: string; readonly from: string; readonly to: string };

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

  /** The entity types an end of a relationship type can have, from the mapping rows of that type. */
  const endTypes = (source: SourceModel, relationshipType: string, end: 'from' | 'to'): string[] => [...new Set(source.relationships.filter((row) => row.type === relationshipType).map((row) => row[end]))];

  /** An end of a stored edge holds an ID and no type. When the mapping allows one type it is that type; when it allows several, the nodes the document holds under that ID say which; when they do not say, and a keyed type is among the possibilities, the end is not known and is undefined. */
  function edgeEnd(sourceId: string, source: SourceModel, edge: EdgeEnds, end: 'from' | 'to', nodes: readonly Ref[]): string | undefined {
    const value = edge[end];
    const all = endTypes(source, edge.t, end);
    // the relationship type is no longer mapped, so the end cannot be told: it is left out, never returned as it was stored
    if (all.length === 0) return nodes.some((node) => keyedType(sourceId, node.t) !== undefined && entityId(sourceId, node.t, node.id) === entityId(sourceId, node.t, value)) ? undefined : decodeStored(value);
    const plain = (types: readonly string[]): boolean => types.every((type) => keyedType(sourceId, type) === undefined);
    if (plain(all)) return plainEnd(sourceId, all, value);
    if (all.length === 1) return entityId(sourceId, all[0] as string, value);
    const named = [...new Set(nodes.filter((node) => all.includes(node.t) && entityId(sourceId, node.t, node.id) === entityId(sourceId, node.t, value)).map((node) => node.t))];
    const possible = named.length > 0 ? named : all;
    if (plain(possible)) return plainEnd(sourceId, possible, value);
    return possible.length === 1 ? entityId(sourceId, possible[0] as string, value) : undefined;
  }

  /** The ID an edge end stands for when the types it can have are known: through the node conversion, so an end and the node it points at agree. */
  const plainEnd = (sourceId: string, types: readonly string[], value: string): string => (types.length === 1 ? entityId(sourceId, types[0] as string, value) : decodeStored(value));

  const refs = (sourceId: string, list: readonly Ref[]): Ref[] => list.map((ref) => ({ ...ref, id: entityId(sourceId, ref.t, ref.id) }));
  /** An edge whose ends cannot be told is left out of the answer, and a possibly raw value is never returned; the stored document is not changed, since nothing here writes it. Documents that hold edges are written by a later feature with typed ends, so only a document stored before then can be ambiguous. */
  const edges = <E extends EdgeEnds>(sourceId: string, list: readonly E[], nodes: readonly Ref[]): E[] => {
    const source = sourceOf(sourceId);
    if (source === undefined) return [...list];
    return list.flatMap((edge) => {
      const from = edgeEnd(sourceId, source, edge, 'from', nodes);
      const to = edgeEnd(sourceId, source, edge, 'to', nodes);
      return from === undefined || to === undefined ? [] : [{ ...edge, from, to }];
    });
  };

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
    layout(sourceId, document) {
      return {
        ...document,
        nodes: document.nodes.map((node) => ({ ...node, id: entityId(sourceId, node.t, node.id) })),
        edges: edges(sourceId, document.edges, document.nodes),
        groups: document.groups.map((group) => ({ ...group, members: refs(sourceId, group.members) })),
      };
    },
    queryContext(sourceId, document) {
      return {
        ...document,
        loaded: { nodes: refs(sourceId, document.loaded.nodes), edges: edges(sourceId, document.loaded.edges, document.loaded.nodes) },
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
