import type { DegreeDeclaration, SourceModel } from '../mapping/model.js';
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
  const degreeProperties = new Map<string, readonly DegreeDeclaration[]>();
  const filterableProperties = new Map<string, readonly string[]>();
  const sortableProperties = new Map<string, readonly string[]>();
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
    for (const declaration of entity.degree ?? []) {
      const degreeProblem = nameProblem(declaration.property);
      if (degreeProblem !== undefined) throw new SourceGateError(source.id, `degree property of entity type ${entity.type}`, declaration.property, degreeProblem);
      const dateProblem = declaration.observedAt === undefined ? undefined : nameProblem(declaration.observedAt);
      if (dateProblem !== undefined) throw new SourceGateError(source.id, `degree date property of entity type ${entity.type}`, declaration.observedAt ?? '', dateProblem);
    }
    for (const [kind, names, into] of [['filterable', entity.filterable, filterableProperties], ['sortable', entity.sortable ?? [], sortableProperties]] as const) {
      for (const property of names) {
        const listedProblem = nameProblem(property);
        if (listedProblem !== undefined) throw new SourceGateError(source.id, `${kind} property of entity type ${entity.type}`, property, listedProblem);
      }
      if (names.length > 0) into.set(entity.type, [...names]);
    }
    if (entity.degree !== undefined) degreeProperties.set(entity.type, entity.degree.map((declaration) => ({ ...declaration })));
    for (const property of [entity.stableId, ...entity.search, ...entity.reference]) properties.add(property);
  }
  const relationshipTypes = new Set<string>();
  const evidenceRows: { type: string; from: string; to: string; properties: readonly string[] }[] = [];
  const relationshipRows: { type: string; from: string; to: string; stableId?: string; observedAt?: string; filterable?: readonly string[]; sortable?: readonly string[] }[] = [];
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
    for (const [kind, names] of [['filterable', relationship.filterable], ['sortable', relationship.sortable ?? []]] as const) {
      for (const property of names) {
        const listedProblem = nameProblem(property);
        if (listedProblem !== undefined) throw new SourceGateError(source.id, `${kind} property of relationship type ${relationship.type}`, property, listedProblem);
      }
    }
    relationshipRows.push({
      type: relationship.type,
      from: relationship.from,
      to: relationship.to,
      ...(relationship.stableId === undefined ? {} : { stableId: relationship.stableId }),
      ...(relationship.observedAt === undefined ? {} : { observedAt: relationship.observedAt }),
      ...(relationship.filterable.length === 0 ? {} : { filterable: [...relationship.filterable] }),
      ...((relationship.sortable ?? []).length === 0 ? {} : { sortable: [...(relationship.sortable ?? [])] }),
    });
    for (const property of relationship.evidence) {
      const evidenceProblem = nameProblem(property);
      if (evidenceProblem !== undefined) throw new SourceGateError(source.id, `evidence property of relationship type ${relationship.type}`, property, evidenceProblem);
    }
    for (const property of [...relationship.evidence, ...(relationship.observedAt === undefined ? [] : [relationship.observedAt]), ...(relationship.stableId === undefined ? [] : [relationship.stableId])]) properties.add(property);
    if (relationship.evidence.length > 0) evidenceRows.push({ type: relationship.type, from: relationship.from, to: relationship.to, properties: [...relationship.evidence] });
  }
  const derivedRules = source.derived.map((rule) => {
    for (const name of [...rule.via, ...(rule.stopListProperty === undefined ? [] : [rule.stopListProperty])]) {
      const problem = nameProblem(name);
      if (problem !== undefined) throw new SourceGateError(source.id, `name in derived rule ${rule.id}`, name, problem);
    }
    return { id: rule.id, from: rule.from, to: rule.to, via: [...rule.via], ...(rule.stopListProperty === undefined ? {} : { stopListProperty: rule.stopListProperty }) };
  });
  return { entityLabels, relationshipTypes, stableIds, searchProperties, referenceProperties, degreeProperties, evidenceRows, relationshipRows, derivedRules, properties, filterableProperties, sortableProperties };
}
