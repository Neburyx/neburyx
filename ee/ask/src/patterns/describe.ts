import type { AskPatternProjection, AskPatternStep } from '@neburyx/contracts';

function stepText(step: AskPatternStep, index: number): string {
  const conditions = step.conditions.length === 0 ? 'no conditions' : `${step.conditions.length} ${step.conditions.length === 1 ? 'condition' : 'conditions'} (${step.conditions.map((condition) => `${condition.on} ${condition.kind}`).join(', ')})`;
  return `step ${index + 1}: ${step.direction} over ${step.relationshipTypes.join(' or ')} to ${step.arrivesAt}, ${conditions}${step.windowed ? ', with a time window' : ''}${step.orderedAfterPrevious === true ? ', after the previous step in time' : ''}${step.fanAtLeast === undefined ? '' : `, from an entity with at least ${step.fanAtLeast} neighbours`}${step.closesAtAnchor === true ? ', arriving back at the starting entity' : ''}`;
}

/** The description of a pattern's structure that the model is shown: type names, directions, counts and kinds; the projection holds nothing else. */
export function describeProjection(projection: AskPatternProjection): string {
  const start = projection.startingEntity === 'asked' ? `starts at an entity of type ${projection.anchorType} that the question gives` : `starts at a held entity of type ${projection.anchorType}`;
  if (projection.kind === 'definition') return [start, ...projection.steps.map(stepText)].join('; ');
  const window = projection.windowed ? ', with a time window' : '';
  if (projection.template === 'shared-attribute') return `${start}; finds entities that share a ${projection.otherType} through ${projection.relationshipTypes.join(' or ')}, at least ${projection.minShared ?? 1} shared${window}`;
  const direction = projection.direction === undefined ? '' : `${projection.direction} `;
  return `${start}; follows ${direction}${projection.relationshipTypes.join(' or ')} to ${projection.otherType}, up to ${projection.maxHops ?? 1} steps${window}`;
}

const SAMPLE_STEP = { relationshipTypes: ['a', 'b'], direction: 'out', arrivesAt: 'c', conditions: [{ on: 'neighbor', kind: 'eq' }, { on: 'relationship', kind: 'in' }, { on: 'neighbor', kind: 'between' }], windowed: true } as const;

/** Every fixed word the descriptions are written with, read from the renderer itself, so a word of the renderer that a pattern's name also has is not taken for a leak. */
function descriptionWords(): string {
  const projections: AskPatternProjection[] = [
    { kind: 'definition', anchorType: 'a', startingEntity: 'asked', steps: [SAMPLE_STEP, { ...SAMPLE_STEP, direction: 'in', conditions: [], windowed: false }, { ...SAMPLE_STEP, direction: 'both' }, { ...SAMPLE_STEP, conditions: [{ on: 'relationship', kind: 'between' }] }, { ...SAMPLE_STEP, orderedAfterPrevious: true, fanAtLeast: 7, closesAtAnchor: true }] },
    { kind: 'definition', anchorType: 'a', startingEntity: 'held', steps: [] },
    { kind: 'preset-run', template: 'shared-attribute', anchorType: 'a', startingEntity: 'asked', otherType: 'b', relationshipTypes: ['c'], minShared: 2, windowed: true },
    { kind: 'preset-run', template: 'linked-entities', anchorType: 'a', startingEntity: 'held', otherType: 'b', relationshipTypes: ['c'], direction: 'both', maxHops: 2, windowed: false },
    { kind: 'preset-run', template: 'linked-entities', anchorType: 'a', startingEntity: 'asked', otherType: 'b', relationshipTypes: ['c'], windowed: false },
  ];
  return projections.map(describeProjection).join('\n');
}
