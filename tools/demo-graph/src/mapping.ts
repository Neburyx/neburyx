import { readFileSync } from 'node:fs';
import { parseDocument } from 'yaml';
import { z } from 'zod';

export class MappingError extends Error {}

const names = z.array(z.string().min(1)).optional();
const name = z.string().min(1);

const mappingFileSchema = z.object({
  sources: z.array(
    z.object({
      id: name,
      uri: name,
      database: name,
      auth: z.object({ username_env: name, password_env: name }),
      synthetic: z.boolean().optional(),
      entities: z.array(
        z.object({
          type: name,
          label: name,
          stable_id: name,
          title: z.string().optional(),
          search: names,
          pii: names,
          filterable: names,
          reference: names,
          display: z.object({ key_properties: names, state_property: name.optional() }).optional(),
        }),
      ),
      relationships: z
        .array(z.object({ type: name, from: name, to: name, stable_id: name.optional(), observed_at: name.optional(), evidence: names, filterable: names }))
        .optional(),
      derived: z.array(z.object({ id: name, from: name, to: name, via: z.array(name), stop_list_property: name.optional() })).optional(),
    }),
  ),
});

export interface MappedEntity {
  readonly type: string;
  readonly label: string;
  readonly stableId: string;
  readonly searchable: readonly string[];
  readonly reference: readonly string[];
  readonly stopList: string | undefined;
  readonly properties: ReadonlySet<string>;
}

export interface DerivedRule {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly via: readonly string[];
  readonly stopListProperty: string | undefined;
}

export interface MappedRelationship {
  readonly type: string;
  readonly from: string;
  readonly to: string;
  readonly stableId: string | undefined;
  readonly observedAt: string | undefined;
  readonly evidence: readonly string[];
  readonly properties: ReadonlySet<string>;
}

export interface MappingSource {
  readonly id: string;
  readonly uri: string;
  readonly database: string;
  readonly usernameEnv: string;
  readonly passwordEnv: string;
  readonly synthetic: boolean;
  readonly entities: readonly MappedEntity[];
  readonly relationships: readonly MappedRelationship[];
  readonly derived: readonly DerivedRule[];
}

const PLACEHOLDER = /\{([^{}]+)\}/g;

function entityOf(raw: z.infer<typeof mappingFileSchema>['sources'][number]['entities'][number], stopList: readonly string[]): MappedEntity {
  const placeholders = [...(raw.title ?? '').matchAll(PLACEHOLDER)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
  const properties = new Set<string>([
    raw.stable_id,
    ...placeholders,
    ...(raw.search ?? []),
    ...(raw.pii ?? []),
    ...(raw.filterable ?? []),
    ...(raw.reference ?? []),
    ...(raw.display?.key_properties ?? []),
    ...(raw.display?.state_property === undefined ? [] : [raw.display.state_property]),
    ...stopList,
  ]);
  return { type: raw.type, label: raw.label, stableId: raw.stable_id, searchable: raw.search ?? [], reference: raw.reference ?? [], stopList: stopList[0], properties };
}

export function readMappingSource(path: string, sourceId?: string): MappingSource {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new MappingError(`${path}: the mapping file cannot be read`);
  }
  const document = parseDocument(text);
  if (document.errors.length > 0) throw new MappingError(`${path}: the mapping file is not valid YAML`);
  let data: unknown;
  try {
    data = document.toJS();
  } catch {
    throw new MappingError(`${path}: the mapping file is not valid YAML data`);
  }
  const parsed = mappingFileSchema.safeParse(data);
  if (!parsed.success) throw new MappingError(`${path}: the mapping file does not have the shape the tool reads`);
  const sources = parsed.data.sources;
  const raw = sourceId === undefined ? (sources.length === 1 ? sources[0] : undefined) : sources.find((source) => source.id === sourceId);
  if (raw === undefined) throw new MappingError(`${path}: name one source of the file with --source`);

  const stopListOf = (entityType: string): string[] =>
    (raw.derived ?? []).flatMap((rule) => (rule.stop_list_property !== undefined && rule.via.some((entry, index) => index % 2 === 1 && entry === entityType) ? [rule.stop_list_property] : []));
  return {
    id: raw.id,
    uri: raw.uri,
    database: raw.database,
    usernameEnv: raw.auth.username_env,
    passwordEnv: raw.auth.password_env,
    synthetic: raw.synthetic === true,
    entities: raw.entities.map((entity) => entityOf(entity, stopListOf(entity.type))),
    derived: (raw.derived ?? []).map((rule) => ({ id: rule.id, from: rule.from, to: rule.to, via: rule.via, stopListProperty: rule.stop_list_property })),
    relationships: (raw.relationships ?? []).map((relationship) => ({
      type: relationship.type,
      from: relationship.from,
      to: relationship.to,
      stableId: relationship.stable_id,
      observedAt: relationship.observed_at,
      evidence: relationship.evidence ?? [],
      properties: new Set<string>([
        ...(relationship.stable_id === undefined ? [] : [relationship.stable_id]),
        ...(relationship.observed_at === undefined ? [] : [relationship.observed_at]),
        ...(relationship.evidence ?? []),
        ...(relationship.filterable ?? []),
      ]),
    })),
  };
}
