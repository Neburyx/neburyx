import type { SourceModel } from '../mapping/model.js';
import { nameProblem } from './render.js';
import type { SourceAllowlist } from './types.js';

export class SourceGateError extends Error {
  constructor(sourceId: string, kind: string, name: string, problem: string) {
    super(`source ${sourceId}: the ${kind} ${name.trim() === '' ? '(empty)' : 'named in the mapping'} ${problem}`);
    this.name = 'SourceGateError';
  }
}

/** The entity types (with their labels) and relationship types a request for this source may name. */
export function allowlistFromMapping(source: SourceModel): SourceAllowlist {
  const entityLabels = new Map<string, string>();
  const stableIds = new Map<string, string>();
  const properties = new Set<string>();
  for (const entity of source.entities) {
    const problem = nameProblem(entity.label);
    if (problem !== undefined) throw new SourceGateError(source.id, `label of entity type ${entity.type}`, entity.label, problem);
    entityLabels.set(entity.type, entity.label);
    // the stable id is written into the Cypher as a quoted name, so it must be quotable
    const stableProblem = nameProblem(entity.stableId);
    if (stableProblem !== undefined) throw new SourceGateError(source.id, `stable id of entity type ${entity.type}`, entity.stableId, stableProblem);
    stableIds.set(entity.type, entity.stableId);
    for (const property of [entity.stableId, ...entity.search, ...entity.reference]) properties.add(property);
  }
  const relationshipTypes = new Set<string>();
  for (const relationship of source.relationships) {
    const problem = nameProblem(relationship.type);
    if (problem !== undefined) throw new SourceGateError(source.id, `relationship type ${relationship.type}`, relationship.type, problem);
    relationshipTypes.add(relationship.type);
    for (const property of [...relationship.evidence, ...(relationship.observedAt === undefined ? [] : [relationship.observedAt]), ...(relationship.stableId === undefined ? [] : [relationship.stableId])]) properties.add(property);
  }
  return { entityLabels, relationshipTypes, stableIds, properties };
}
