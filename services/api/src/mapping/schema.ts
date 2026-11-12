import { RESERVED_SOURCE_IDS } from './reserved-source-ids.js';
import { addressableTextOfAtMost, aiSettingsSchema, iconKeySchema, MAX_CASE_REF_LENGTH, MAX_STABLE_ID_LENGTH, PII_CLASSES, presetTemplateSchema, type PiiClass } from '@neburyx/contracts';
import { z } from 'zod';
import { isWellFormed } from '../reference/well-formed.js';
import { budgetsSchema } from './budgets.js';
import { retentionSchema } from './retention.js';

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const URI_SCHEMES = ['neo4j:', 'neo4j+s:', 'neo4j+ssc:', 'bolt:', 'bolt+s:', 'bolt+ssc:'];

/** A name is well-formed Unicode: a lone surrogate would be replaced when the name is encoded as UTF-8, so two different names could share one encoding. */
const name = z.string().min(1).refine((text) => isWellFormed(text) && !text.includes('\u0000'), { message: 'must be well-formed Unicode (no unpaired surrogate, no NUL)' });
const property = z.string().min(1).regex(/^[^{}]*$/);
const propertyList = z.array(property);

const envName = z.string().regex(ENV_NAME);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A `pii` entry: a property name, or `{ property, class }` where the class (`name`, `email`, `phone`, `date` or `text`) picks the shape of its mask. */
const piiEntry = z.unknown().transform((value, context): { readonly property: string; readonly class?: PiiClass } => {
  const problem = (message: string) => {
    context.addIssue({ code: 'custom', message });
    return z.NEVER;
  };
  if (typeof value === 'string') return property.safeParse(value).success ? { property: value } : problem('has an invalid format');
  if (!isRecord(value)) return problem('must be a property name or { property, class }');
  const unknownKey = Object.keys(value).find((key) => key !== 'property' && key !== 'class');
  if (unknownKey !== undefined) return problem(`has the key ${unknownKey}, which is not property or class`);
  const named = value['property'];
  const given = value['class'];
  if (typeof named !== 'string' || !property.safeParse(named).success) return problem('has no property name');
  if (given === undefined) return { property: named };
  const piiClass = PII_CLASSES.find((candidate) => candidate === given);
  return piiClass === undefined ? problem(`has a class that is not ${PII_CLASSES.join(', ')}`) : { property: named, class: piiClass };
});

function isPlainData(root: unknown): boolean {
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === null || typeof value === 'string' || typeof value === 'boolean') continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return false;
      continue;
    }
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
      pending.push(...Object.values(value));
      continue;
    }
    return false;
  }
  return true;
}

export const uriSchema = z.string().superRefine((value, context) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    context.addIssue({ code: 'custom', message: 'is not a valid connection address' });
    return;
  }
  if (!URI_SCHEMES.includes(url.protocol)) {
    context.addIssue({ code: 'custom', message: 'has a scheme that is not neo4j, neo4j+s, neo4j+ssc, bolt, bolt+s or bolt+ssc' });
  } else if (url.hostname === '') {
    context.addIssue({ code: 'custom', message: 'has no host' });
  } else if (url.username !== '' || url.password !== '') {
    context.addIssue({ code: 'custom', message: 'carries credentials; use auth' });
  }
});

const authSchema = z.strictObject({
  kind: z.literal('basic'),
  username_env: envName,
  password_env: envName,
});

const displaySchema = z.strictObject({
  name: name.optional(),
  icon: iconKeySchema.optional(),
  key_properties: propertyList.optional(),
  state_property: property.optional(),
});

/** A property read by name in a statement, so one the gate could not quote (a backtick, a backslash, a control character, or only whitespace) is refused here. */
const quotableProperty = property.refine((text) => text.trim() !== '' && !/[`\\\u0000-\u001f\u007f]/.test(text), { message: 'must not be only whitespace or hold a backtick, a backslash or a control character' });

const degreeEntrySchema = z.strictObject({
  type: name,
  direction: z.enum(['out', 'in']),
  property: quotableProperty,
  observed_at: quotableProperty.optional(),
});

const entitySchema = z.strictObject({
  type: name,
  label: name,
  stable_id: property,
  title: name.optional(),
  search: propertyList.optional(),
  reference: propertyList.optional(),
  pii: z.array(piiEntry).optional(),
  filterable: propertyList.optional(),
  sortable: propertyList.optional(),
  link: z.string().optional(),
  link_carries_value: z.boolean().optional(),
  display: displaySchema.optional(),
  degree: z.array(degreeEntrySchema).optional(),
});

const relationshipSchema = z.strictObject({
  type: name,
  from: name,
  to: name,
  stable_id: property.optional(),
  observed_at: property.optional(),
  evidence: propertyList.optional(),
  filterable: propertyList.optional(),
  sortable: propertyList.optional(),
  evidence_link: z.string().optional(),
});

const derivedSchema = z.strictObject({
  id: name,
  from: name,
  to: name,
  via: z.array(name),
  rule_version: z.number().int().min(1),
  stop_list_property: property.optional(),
});

function isStringMap(value: unknown): value is Readonly<Record<string, string>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  return Object.getOwnPropertyNames(value).every((key) => {
    const member: unknown = Object.getOwnPropertyDescriptor(value, key)?.value;
    return key.length > 0 && typeof member === 'string' && member.length > 0;
  });
}

const stringMap = z.custom<Readonly<Record<string, string>>>(isStringMap, { message: 'must be a map of non-empty text keys and values' });

const presetSchema = z.strictObject({
  id: name,
  name,
  template: presetTemplateSchema,
  bind: stringMap,
  labels: stringMap.optional(),
});

const vocabularySchema = z.strictObject({ case_ref: name.optional() });

const demoCaseSchema = z.strictObject({
  entity: z.strictObject({ type: addressableTextOfAtMost(MAX_STABLE_ID_LENGTH), id: addressableTextOfAtMost(MAX_STABLE_ID_LENGTH) }),
  case_ref: addressableTextOfAtMost(MAX_CASE_REF_LENGTH),
});

const sourceSchema = z.strictObject({
  id: z.string().regex(SOURCE_ID).refine((id) => !RESERVED_SOURCE_IDS.includes(id), { message: 'is the first segment of the paths the API answers, so a deep link to this source could not reach the app: use another ID' }),
  uri: uriSchema,
  database: name,
  auth: authSchema,
  synthetic: z.boolean().optional(),
  demo_case: demoCaseSchema.optional(),
  budgets: budgetsSchema.optional(),
  vocabulary: vocabularySchema.optional(),
  entities: z.array(entitySchema).min(1),
  relationships: z.array(relationshipSchema).optional(),
  derived: z.array(derivedSchema).optional(),
  patterns: z.array(presetSchema).optional(),
  style_rules: z.array(z.unknown().refine(isPlainData, { message: 'is not plain data (text, numbers, true or false, lists and maps)' })).optional(),
});

export const mappingFileSchema = z.strictObject({ sources: z.array(sourceSchema), retention: retentionSchema.optional(), ai: aiSettingsSchema.optional() });

export type RawMappingFile = z.infer<typeof mappingFileSchema>;
export type RawSource = z.infer<typeof sourceSchema>;
export type RawEntity = z.infer<typeof entitySchema>;
export type RawRelationship = z.infer<typeof relationshipSchema>;
export type RawDerivedRule = z.infer<typeof derivedSchema>;
export type RawPreset = z.infer<typeof presetSchema>;
