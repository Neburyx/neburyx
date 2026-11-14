/** The refusal families the question file may name; a copy of the model-selectable part of the closed list `ASK_REFUSAL_FAMILIES` of the contracts (the two families only the server sets are left out); `family.test.ts` compares the two. */
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
