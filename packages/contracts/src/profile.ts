import { z } from 'zod';
import { iconKeySchema, presetTemplateSchema } from './mapping.js';

const name = z.string().min(1);
const nameList = z.array(name);

export const BIND_KEYS = ['anchor', 'attribute', 'target', 'via'] as const;

export const entityTypeProfileSchema = z.strictObject({
  type: name,
  label: name,
  keyed: z.boolean(),
  stableIdProperty: name,
  displayName: name,
  icon: iconKeySchema,
  title: name,
  titleUsesPii: z.boolean(),
  keyProperties: nameList,
  stateProperty: name.nullable(),
  searchable: nameList,
  filterable: nameList,
  /** Properties an expansion may rank by. */
  sortable: nameList.default([]),
  pii: nameList,
  /** Every property the mapping names for the type, in the order a record is projected to; names only, no values. */
  properties: nameList,
});

export const relationshipTypeProfileSchema = z.strictObject({
  type: name,
  from: name,
  to: name,
  aggregate: z.boolean(),
  observedAt: name.nullable(),
  /** The property that holds a relationship's stable ID; none for a type whose relationships are one aggregate. */
  stableIdProperty: name.nullable(),
  filterable: nameList,
  /** Properties an expansion may rank by; the row's `observedAt` is sortable and filterable without being listed. */
  sortable: nameList.default([]),
  evidence: nameList,
  /** Every property the mapping names for the relationship type, in the order a record is projected to; names only, no values. */
  properties: nameList,
});

export const derivedRuleProfileSchema = z.strictObject({
  id: name,
  from: name,
  to: name,
  via: nameList,
  ruleVersion: z.number().int().min(1),
});

export const presetProfileSchema = z.strictObject({
  id: name,
  name,
  template: presetTemplateSchema,
  bind: z.partialRecord(z.enum(BIND_KEYS), name),
  labels: z.array(z.strictObject({ key: name, text: name })),
});

export const sourceProfileSchema = z.strictObject({
  sourceId: name,
  synthetic: z.boolean(),
  vocabulary: z.strictObject({ caseRef: name.nullable() }),
  entityTypes: z.array(entityTypeProfileSchema),
  relationshipTypes: z.array(relationshipTypeProfileSchema),
  derivedRules: z.array(derivedRuleProfileSchema),
  presets: z.array(presetProfileSchema),
  mappingExcerpt: z.string(),
});

export type SourceProfile = z.infer<typeof sourceProfileSchema>;
