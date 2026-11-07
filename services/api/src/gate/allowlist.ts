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
  const searchProperties = new Map<string, readonly string[]>();
  const referenceProperties = new Map<string, readonly string[]>();
  for (const entity of source.entities) {
    const problem = nameProblem(entity.label);
    if (problem !== undefined) throw new SourceGateError(source.id, `label of entity type ${entity.type}`, entity.label, problem);
    entityLabels.set(entity.type, entity.label);
    // the stable id is written into the Cypher as a quoted name, so it must be quotable
    const stableProblem = nameProblem(entity.stableId);
    if (stableProblem !== undefined) throw new SourceGateError(source.id, `stable id of entity type ${entity.type}`, entity.stableId, stableProblem);
    stableIds.set(entity.type, entity.stableId);
    for (const property of entity.search) {
      const searchProblem = nameProblem(property);
      if (searchProblem !== undefined) throw new SourceGateError(source.id, `search property of entity type ${entity.type}`, property, searchProblem);
    }
    searchProperties.set(entity.type, [...entity.search]);
    for (const property of entity.reference) {
      const referenceProblem = nameProblem(property);
      if (referenceProblem !== undefined) throw new SourceGateError(source.id, `reference property of entity type ${entity.type}`, property, referenceProblem);
    }
    referenceProperties.set(entity.type, [...entity.reference]);
    for (const property of [entity.stableId, ...entity.search, ...entity.reference]) properties.add(property);
  }
  const relationshipTypes = new Set<string>();
  const evidenceRows: { type: string; from: string; to: string; properties: readonly string[] }[] = [];
  const relationshipRows: { type: string; from: string; to: string; stableId?: string; observedAt?: string }[] = [];
  for (const relationship of source.relationships) {
    const problem = nameProblem(relationship.type);
    if (problem !== undefined) throw new SourceGateError(source.id, `relationship type ${relationship.type}`, relationship.type, problem);
    relationshipTypes.add(relationship.type);
    if (relationship.stableId !== undefined) {
      const stableProblem = nameProblem(relationship.stableId);
      if (stableProblem !== undefined) throw new SourceGateError(source.id, `stable id of relationship type ${relationship.type}`, relationship.stableId, stableProblem);
    }
    if (relationship.observedAt !== undefined) {
      const observedProblem = nameProblem(relationship.observedAt);
      if (observedProblem !== undefined) throw new SourceGateError(source.id, `observed time of relationship type ${relationship.type}`, relationship.observedAt, observedProblem);
    }
    relationshipRows.push({
      type: relationship.type,
      from: relationship.from,
      to: relationship.to,
      ...(relationship.stableId === undefined ? {} : { stableId: relationship.stableId }),
      ...(relationship.observedAt === undefined ? {} : { observedAt: relationship.observedAt }),
    });
    for (const property of relationship.evidence) {
      const evidenceProblem = nameProblem(property);
      if (evidenceProblem !== undefined) throw new SourceGateError(source.id, `evidence property of relationship type ${relationship.type}`, property, evidenceProblem);
    }
    for (const property of [...relationship.evidence, ...(relationship.observedAt === undefined ? [] : [relationship.observedAt]), ...(relationship.stableId === undefined ? [] : [relationship.stableId])]) properties.add(property);
    if (relationship.evidence.length > 0) evidenceRows.push({ type: relationship.type, from: relationship.from, to: relationship.to, properties: [...relationship.evidence] });
  }
  return { entityLabels, relationshipTypes, stableIds, searchProperties, referenceProperties, evidenceRows, relationshipRows, properties };
}
