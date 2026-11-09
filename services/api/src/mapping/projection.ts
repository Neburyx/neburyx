import type { EntityModel, RelationshipModel } from './model.js';

const unique = (values: readonly string[]): string[] => [...new Set(values)];

/** The properties the mapping names for an entity type, in a fixed order: the list a record is projected to, and the list the source profile gives, so the two cannot differ. */
export function entityProjection(entity: Pick<EntityModel, 'stableId' | 'titleProperties' | 'search' | 'reference' | 'pii' | 'filterable' | 'display'>): string[] {
  return unique([
    entity.stableId,
    ...entity.titleProperties,
    ...entity.search,
    ...entity.reference,
    ...entity.pii,
    ...entity.filterable,
    ...entity.display.keyProperties,
    ...(entity.display.stateProperty === undefined ? [] : [entity.display.stateProperty]),
  ]);
}

/** The properties the mapping names for a relationship type, in a fixed order: the list a record is projected to, and the list the source profile gives. */
export function relationshipProjection(relationship: Pick<RelationshipModel, 'stableId' | 'observedAt' | 'evidence' | 'filterable'>): string[] {
  return unique([...(relationship.stableId === undefined ? [] : [relationship.stableId]), ...(relationship.observedAt === undefined ? [] : [relationship.observedAt]), ...relationship.evidence, ...relationship.filterable]);
}
