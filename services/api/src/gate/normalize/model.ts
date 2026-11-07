import type { PiiClass } from '@neburyx/contracts';
import type { SourceModel } from '../../mapping/model.js';

/** What the normalizer needs to know of one entity type of a source: how to recognise it, name it, and which properties of it are shown. */
export interface EntityNormalizer {
  readonly type: string;
  readonly label: string;
  readonly stableId: string;
  readonly title: string;
  readonly titleProperties: readonly string[];
  /** The properties the mapping names for the type, in a fixed order: the projection list; any other property of a record is never shown. */
  readonly projection: readonly string[];
  /** The projected properties a node should have, so that one it lacks is reported as missing: the title placeholders and the key properties. */
  readonly expected: readonly string[];
  /** The properties the mapping marks `pii`, and the class of those that have one. */
  readonly pii: readonly string[];
  readonly piiClasses: Readonly<Record<string, PiiClass>>;
}

/** One relationship row of the mapping: a type between two entity types, with the properties of it that are shown. */
export interface RelationshipNormalizer {
  readonly type: string;
  readonly from: string;
  readonly to: string;
  /** Present when the type has a `stable_id`: each relationship is then an edge of its own; without it all of one type between two entities are one aggregate edge. */
  readonly stableId?: string;
  readonly observedAt?: string;
  readonly evidence: readonly string[];
  /** The properties the mapping names for the relationship, in a fixed order; any other property is never shown. */
  readonly projection: readonly string[];
}

/** A derived rule: a link between two entities of the given types, found through the chain `via` (relationship type, entity type, relationship type, ...). */
export interface DerivedNormalizer {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly via: readonly string[];
  readonly version: number;
}

export interface NormalizeModel {
  /** The entity types of the source that a label maps to; two types may share a label. */
  readonly entitiesByLabel: ReadonlyMap<string, readonly EntityNormalizer[]>;
  readonly entitiesByType: ReadonlyMap<string, EntityNormalizer>;
  readonly relationships: readonly RelationshipNormalizer[];
  readonly derived: readonly DerivedNormalizer[];
}

export const EMPTY_MODEL: NormalizeModel = { entitiesByLabel: new Map(), entitiesByType: new Map(), relationships: [], derived: [] };

/** What a template's `normalize` is given besides the rows: the source of the request, whether the page was cut, and the source's model. */
export interface NormalizeContext {
  readonly sourceId: string;
  /** True when the rows are not the whole answer (the read found more than the page). */
  readonly hasMore: boolean;
  readonly model: NormalizeModel;
  /** The page limit of the request, which a template that counts rows to a cap needs to check what the read gave. */
  readonly limit?: number;
  /** The cap of a bounded degree count, from the source's budgets. */
  readonly countCap?: number;
  /** The validated parameters of the request. */
  readonly params?: Readonly<Record<string, unknown>>;
}

const unique = (values: readonly string[]): string[] => [...new Set(values)];

export function normalizeModelOf(source: SourceModel): NormalizeModel {
  const entitiesByLabel = new Map<string, EntityNormalizer[]>();
  const entitiesByType = new Map<string, EntityNormalizer>();
  for (const entity of source.entities) {
    const normalizer: EntityNormalizer = {
      type: entity.type,
      label: entity.label,
      stableId: entity.stableId,
      title: entity.title,
      titleProperties: entity.titleProperties,
      projection: unique([
        entity.stableId,
        ...entity.titleProperties,
        ...entity.search,
        ...entity.reference,
        ...entity.pii,
        ...entity.filterable,
        ...entity.display.keyProperties,
        ...(entity.display.stateProperty === undefined ? [] : [entity.display.stateProperty]),
      ]),
      expected: unique([...entity.titleProperties, ...entity.display.keyProperties]),
      pii: entity.pii,
      piiClasses: entity.piiClasses ?? {},
    };
    entitiesByLabel.set(entity.label, [...(entitiesByLabel.get(entity.label) ?? []), normalizer]);
    entitiesByType.set(entity.type, normalizer);
  }
  const relationships = source.relationships.map(
    (relationship): RelationshipNormalizer => ({
      type: relationship.type,
      from: relationship.from,
      to: relationship.to,
      ...(relationship.stableId === undefined ? {} : { stableId: relationship.stableId }),
      ...(relationship.observedAt === undefined ? {} : { observedAt: relationship.observedAt }),
      evidence: relationship.evidence,
      projection: unique([...(relationship.stableId === undefined ? [] : [relationship.stableId]), ...(relationship.observedAt === undefined ? [] : [relationship.observedAt]), ...relationship.evidence, ...relationship.filterable]),
    }),
  );
  const derived = source.derived.map((rule): DerivedNormalizer => ({ id: rule.id, from: rule.from, to: rule.to, via: rule.via, version: rule.ruleVersion }));
  return { entitiesByLabel, entitiesByType, relationships, derived };
}
