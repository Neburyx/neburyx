/** The refusal families the question file may name; a copy of the closed list of the refusal feature, compared with it by a test once it exists. */
export const REFUSAL_FAMILIES = [
  'path',
  'property-selection',
  'similar-records',
  'ranking-or-aggregate',
  'attribute-combination',
  'indirect-attribute',
  'unnamed-relation',
  'judgement',
  'personal-data',
  'loaded-view',
  'other',
] as const;
