import { z } from 'zod';

export const COUNT_QUALITIES = ['exact', 'estimated', 'lowerBound', 'unknown'] as const;

/** A count says how sure it is. A count with no value is `unknown`, and an `unknown` count has no value (TAS §6). */
export const countSchema = z
  .strictObject({
    value: z.number().int().nonnegative().optional(),
    quality: z.enum(COUNT_QUALITIES),
    scope: z.string().min(1),
  })
  .refine((count) => (count.quality === 'unknown') === (count.value === undefined), { message: 'a count has a value exactly when its quality is not unknown', path: ['value'] });

export const elementRefSchema = z.strictObject({ sourceId: z.string().min(1), entityType: z.string().min(1), stableId: z.string().min(1) });

/** What a property value is: the kind of its type; for a `pii` field that is masked, the class the mapping gives it (`name`, `email`, `phone`, `date` or `text`). */
export const DATA_CLASSES = ['text', 'number', 'boolean', 'date', 'dateTime', 'localDateTime', 'time', 'localTime', 'duration', 'point', 'list', 'other', 'unknown', 'name', 'email', 'phone'] as const;

export const propertySchema = z.strictObject({
  key: z.string().min(1),
  value: z.unknown().optional(),
  dataClass: z.enum(DATA_CLASSES),
  masked: z.boolean(),
  maskedBy: z.enum(['policy', 'request']).optional(),
});

export const nodeSchema = z.strictObject({
  ref: elementRefSchema,
  display: z.strictObject({ title: z.string(), type: z.string().min(1), badges: z.array(z.string()).optional() }),
  properties: z.array(propertySchema),
  qualityFlags: z.array(z.string()),
  provenanceRefs: z.array(z.string()),
  authorization: z.strictObject({ canInspect: z.boolean(), canExport: z.boolean() }),
});

export type Count = z.infer<typeof countSchema>;
export type ElementRef = z.infer<typeof elementRefSchema>;
export type DataClass = (typeof DATA_CLASSES)[number];
export type GraphProperty = z.infer<typeof propertySchema>;
export type GraphNode = z.infer<typeof nodeSchema>;

const text = z.string().min(1);

/** The three forms of an edge's reference: a stored relationship with a stable ID, all of one type between two entities without one, and a derived edge. */
export const edgeRefSchema = z.union([
  z.strictObject({ sourceId: text, stableId: text }),
  z.strictObject({ sourceId: text, aggregate: z.strictObject({ type: text, from: elementRefSchema, to: elementRefSchema }) }),
  z.strictObject({ sourceId: text, derived: z.strictObject({ ruleId: text, from: elementRefSchema, to: elementRefSchema }) }),
]);

export const edgeSchema = z
  .strictObject({
    ref: edgeRefSchema,
    memberCount: countSchema.optional(),
    from: elementRefSchema,
    to: elementRefSchema,
    type: text,
    direction: z.literal('from-to'),
    semantics: z.enum(['stored', 'derived', 'unknown']),
    observedFirst: text.optional(),
    observedLast: text.optional(),
    derivation: z.strictObject({ ruleId: text, ruleVersion: z.number().int().nonnegative(), supportingEdgeRefs: z.array(edgeRefSchema) }).optional(),
    properties: z.array(propertySchema),
    evidenceRefs: z.array(z.string()),
    observedAt: text.optional(),
    validFrom: text.optional(),
    validTo: text.optional(),
    qualityFlags: z.array(z.string()),
  })
  .refine((edge) => (edge.semantics === 'derived') === (edge.derivation !== undefined), { message: 'a derived edge has a derivation and no other edge has one', path: ['derivation'] })
  .refine((edge) => 'aggregate' in edge.ref === (edge.memberCount !== undefined), { message: 'an aggregate edge has a member count and no other edge has one', path: ['memberCount'] });

export type EdgeRef = z.infer<typeof edgeRefSchema>;
export type GraphEdge = z.infer<typeof edgeSchema>;
