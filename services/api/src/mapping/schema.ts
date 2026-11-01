import { iconKeySchema, presetTemplateSchema } from '@neburyx/contracts';
import { z } from 'zod';
import { budgetsSchema } from './budgets.js';

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const URI_SCHEMES = ['neo4j:', 'neo4j+s:', 'neo4j+ssc:', 'bolt:', 'bolt+s:', 'bolt+ssc:'];

const name = z.string().min(1);
const property = z.string().min(1).regex(/^[^{}]*$/);
const propertyList = z.array(property);

const envName = z.string().regex(ENV_NAME);

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
  icon: iconKeySchema.optional(),
  key_properties: propertyList.optional(),
  state_property: property.optional(),
});

const entitySchema = z.strictObject({
  type: name,
  label: name,
  stable_id: property,
  title: name.optional(),
  search: propertyList.optional(),
  reference: propertyList.optional(),
  pii: propertyList.optional(),
  filterable: propertyList.optional(),
  link: z.string().optional(),
  display: displaySchema.optional(),
});

const relationshipSchema = z.strictObject({
  type: name,
  from: name,
  to: name,
  stable_id: property.optional(),
  observed_at: property.optional(),
  evidence: propertyList.optional(),
  filterable: propertyList.optional(),
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

const sourceSchema = z.strictObject({
  id: z.string().regex(SOURCE_ID),
  uri: uriSchema,
  database: name,
  auth: authSchema,
  synthetic: z.boolean().optional(),
  budgets: budgetsSchema.optional(),
  vocabulary: vocabularySchema.optional(),
  entities: z.array(entitySchema).min(1),
  relationships: z.array(relationshipSchema).optional(),
  derived: z.array(derivedSchema).optional(),
  patterns: z.array(presetSchema).optional(),
  style_rules: z.array(z.unknown().refine(isPlainData, { message: 'is not plain data (text, numbers, true or false, lists and maps)' })).optional(),
});

export const mappingFileSchema = z.strictObject({ sources: z.array(sourceSchema) });

export type RawMappingFile = z.infer<typeof mappingFileSchema>;
export type RawSource = z.infer<typeof sourceSchema>;
export type RawEntity = z.infer<typeof entitySchema>;
export type RawRelationship = z.infer<typeof relationshipSchema>;
export type RawDerivedRule = z.infer<typeof derivedSchema>;
export type RawPreset = z.infer<typeof presetSchema>;
