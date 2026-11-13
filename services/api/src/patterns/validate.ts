import { patternDefinitionSchema, patternProblemsOf, type ExpandFilter, type PatternDefinition, type PatternProblem } from '@neburyx/contracts';
import type { EntityModel, RelationshipModel, SourceModel } from '../mapping/model.js';

export interface PatternValidationOptions {
  /** Whether masking is asked: a condition on a personal-data property is then a problem, as it is for Expand. */
  readonly mask?: boolean | undefined;
}

/** The properties the mapping names for an entity type: the ones it declares for any use. */
function namedByEntity(entity: EntityModel): ReadonlySet<string> {
  return new Set([entity.stableId, ...entity.titleProperties, ...entity.search, ...entity.reference, ...entity.pii, ...entity.filterable, ...(entity.sortable ?? []), ...entity.display.keyProperties, ...(entity.display.stateProperty === undefined ? [] : [entity.display.stateProperty]), ...(entity.degree ?? []).map((declaration) => declaration.property)]);
}

function namedByRelationship(row: RelationshipModel): ReadonlySet<string> {
  return new Set([...(row.stableId === undefined ? [] : [row.stableId]), ...(row.observedAt === undefined ? [] : [row.observedAt]), ...row.evidence, ...row.filterable, ...(row.sortable ?? [])]);
}

/** A row of the mapping that carries a step: the previous node type to the type the step arrives at, in the stated direction. */
function carries(row: RelationshipModel, previous: string, arrives: string, direction: PatternDefinition['steps'][number]['direction']): boolean {
  const forward = row.from === previous && row.to === arrives;
  const backward = row.from === arrives && row.to === previous;
  return direction === 'out' ? forward : direction === 'in' ? backward : forward || backward;
}

type PropertyProblem = 'unknown-property' | 'not-filterable';

/** What a property of a mapping row or entity type is for a condition: not named at all, named and not declared filterable, or fine. */
function propertyProblem(property: string, named: ReadonlySet<string>, filterable: readonly string[], observedAt?: string): PropertyProblem | undefined {
  if (!named.has(property)) return 'unknown-property';
  return filterable.includes(property) || property === observedAt ? undefined : 'not-filterable';
}

/**
 * The problems of a pattern against one source's mapping: a type or property the mapping does not name, a step that does not join the previous node type, a property that is not declared `filterable`, and a personal-data
 * property while masking is asked. The definition must pass the schema first (the schema's own problems are returned alone otherwise). The mapping is the only input: nothing is read from the source, and no name or value of the
 * definition is in a problem.
 */
export function validatePattern(input: unknown, source: SourceModel, options: PatternValidationOptions = {}): PatternProblem[] {
  const shape = patternProblemsOf(input);
  if (shape.length > 0) return shape;
  const definition = patternDefinitionSchema.parse(input);
  const entities = new Map(source.entities.map((entity) => [entity.type, entity]));
  const problems: PatternProblem[] = [];
  if (!entities.has(definition.anchorType)) problems.push({ path: ['anchorType'], code: 'unknown-entity-type' });
  let previous = definition.anchorType;
  definition.steps.forEach((step, stepIndex) => {
    const arrives = entities.get(step.arrivesAt);
    if (arrives === undefined) problems.push({ path: ['steps', stepIndex, 'arrivesAt'], code: 'unknown-entity-type' });
    const joinable = entities.has(previous) && arrives !== undefined;
    const carrying: RelationshipModel[] = [];
    step.relationshipTypes.forEach((type, typeIndex) => {
      const rows = source.relationships.filter((row) => row.type === type);
      if (rows.length === 0) {
        problems.push({ path: ['steps', stepIndex, 'relationshipTypes', typeIndex], code: 'unknown-relationship-type' });
        return;
      }
      if (!joinable) return;
      const here = rows.filter((row) => carries(row, previous, step.arrivesAt, step.direction));
      if (here.length === 0) problems.push({ path: ['steps', stepIndex, 'relationshipTypes', typeIndex], code: 'relationship-does-not-join' });
      carrying.push(...here);
    });
    (step.conditions ?? []).forEach((condition: ExpandFilter, conditionIndex) => {
      const path = ['steps', stepIndex, 'conditions', conditionIndex, 'property'];
      if (condition.on === 'neighbor') {
        if (arrives === undefined) return;
        const found = propertyProblem(condition.property, namedByEntity(arrives), arrives.filterable);
        if (found !== undefined) problems.push({ path, code: found });
        else if (options.mask === true && arrives.pii.includes(condition.property)) problems.push({ path, code: 'personal-data-masked' });
        return;
      }
      const found = carrying.map((row) => propertyProblem(condition.property, namedByRelationship(row), row.filterable, row.observedAt));
      const worst = found.includes('unknown-property') ? 'unknown-property' : found.find((problem) => problem !== undefined);
      if (worst !== undefined) problems.push({ path, code: worst });
    });
    previous = step.arrivesAt;
  });
  return problems;
}
