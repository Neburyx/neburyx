import { z } from 'zod';
import { FILTER_KINDS } from './expand.js';
import { iconKeySchema, MAX_STYLE_LABEL, presetTemplateSchema, STYLE_TONES } from './mapping.js';

const name = z.string().min(1);
const nameList = z.array(name);

/** A property's kind as a client may show it: one of the filter kinds the mapping declares, or `unknown` (never guessed from values or names). */
const FILTER_KINDS_OR_UNKNOWN = [...FILTER_KINDS, 'unknown'] as const;
/** The longest label and unit a mapping gives a property. */
export const MAX_PROPERTY_LABEL = 80;
export const MAX_PROPERTY_UNIT = 20;

/** How a screen names a property and the unit it is measured in. */
const propertyDisplayProfileSchema = z.record(name, z.strictObject({ label: z.string().min(1).max(MAX_PROPERTY_LABEL).optional(), unit: z.string().min(1).max(MAX_PROPERTY_UNIT).optional() }));
const filterKindsSchema = z.record(name, z.enum(FILTER_KINDS_OR_UNKNOWN));

export const BIND_KEYS = ['anchor', 'attribute', 'target', 'via'] as const;

export const entityTypeProfileSchema = z.strictObject({
  type: name,
  label: name,
  /** The mapping's plain-text meaning of the type; absent when it has none. */
  description: z.string().min(1).max(300).optional(),
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
  /** The kind the mapping declares for each filterable property, or `unknown`; a hint for screens, never read by a statement. Absent from an older answer; a property named `__proto__` is never listed. */
  filterKinds: filterKindsSchema.optional(),
  /** The label and the unit the mapping gives a property, for the properties it gives some; absent when it gives none. */
  propertyDisplay: propertyDisplayProfileSchema.optional(),
  /** Properties an expansion may rank by. */
  sortable: nameList.default([]),
  pii: nameList,
  /** Every property the mapping names for the type, in the order a record is projected to; names only, no values. */
  properties: nameList,
  /** Whether "Open source record" is offered: never, always, or only while the request is not masked (a keyed type whose mapping opts in). A flag only; the template is never sent. Absent means none. */
  recordLink: z.enum(['none', 'always', 'unmasked']).optional(),
});

export const relationshipTypeProfileSchema = z.strictObject({
  type: name,
  from: name,
  to: name,
  /** As for an entity type. */
  description: z.string().min(1).max(300).optional(),
  aggregate: z.boolean(),
  observedAt: name.nullable(),
  /** The property that holds a relationship's stable ID; none for a type whose relationships are one aggregate. */
  stableIdProperty: name.nullable(),
  filterable: nameList,
  /** As for an entity type; the row's time property appears when the mapping declares its kind. */
  filterKinds: filterKindsSchema.optional(),
  propertyDisplay: propertyDisplayProfileSchema.optional(),
  /** Properties an expansion may rank by; the row's `observedAt` is sortable and filterable without being listed. */
  sortable: nameList.default([]),
  evidence: nameList,
  /** Every property the mapping names for the relationship type, in the order a record is projected to; names only, no values. */
  properties: nameList,
  /** True when the row has an evidence link, so a stored relationship's records may be opened. A flag only; the template is never sent. Absent means false. */
  recordLink: z.boolean().optional(),
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

const toneSchema = z.enum(STYLE_TONES);

/** What a style rule does to a node: exactly one of a badge or colour of a tone, an icon, or a larger size. */
export const styleEffectSchema = z.union([
  z.strictObject({ badge: toneSchema }),
  z.strictObject({ color: toneSchema }),
  z.strictObject({ icon: iconKeySchema }),
  z.strictObject({ size: z.literal('larger') }),
]);

export type StyleEffect = z.infer<typeof styleEffectSchema>;

/** A style rule as a screen shows it: the type it applies to, its effect and its condition in words, built by the server from the mapping's condition. */
export const styleRuleProfileSchema = z.strictObject({
  id: name,
  label: z.string().min(1).max(MAX_STYLE_LABEL),
  appliesTo: name,
  effect: styleEffectSchema,
  condition: name,
});

export type StyleRuleProfile = z.infer<typeof styleRuleProfileSchema>;

export const sourceProfileSchema = z.strictObject({
  sourceId: name,
  synthetic: z.boolean(),
  vocabulary: z.strictObject({ caseRef: name.nullable() }),
  entityTypes: z.array(entityTypeProfileSchema),
  relationshipTypes: z.array(relationshipTypeProfileSchema),
  derivedRules: z.array(derivedRuleProfileSchema),
  presets: z.array(presetProfileSchema),
  /** The style rules in mapping order; the server always sends the list (empty for a mapping with none), and it is absent only from an older answer. */
  styleRules: z.array(styleRuleProfileSchema).optional(),
  mappingExcerpt: z.string(),
});

export type SourceProfile = z.infer<typeof sourceProfileSchema>;
