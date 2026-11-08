import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod';

export type IdentifierKind = 'entity type' | 'label' | 'relationship type' | 'property key';

export interface Identifier {
  readonly name: string;
  readonly kind: IdentifierKind;
  readonly pack: string;
}

export class PackError extends Error {}

const PACKS_FOLDER = 'domain-packs';
const MAPPING_FILE = 'neburyx.yaml';
const TITLE_PLACEHOLDER = /\{([^{}]*)\}/g;

const name = z.string().min(1);
const names = z.array(name).optional();
/** A `pii` entry is a property name, or `{ property, class }`; the check needs the property name only. */
const piiEntries = z.array(z.union([name, z.object({ property: name, class: z.string() })])).optional();

const packFileSchema = z.object({
  sources: z.array(
    z.object({
      entities: z.array(
        z.object({
          type: name,
          label: name,
          stable_id: name,
          title: z.string().optional(),
          search: names,
          pii: piiEntries,
          filterable: names,
          reference: names,
          display: z.object({ key_properties: names, state_property: name.optional() }).optional(),
          degree: z.array(z.object({ type: name, direction: name, property: name, observed_at: name.optional() })).optional(),
        }),
      ),
      relationships: z
        .array(
          z.object({
            type: name,
            stable_id: name.optional(),
            observed_at: name.optional(),
            evidence: names,
            filterable: names,
          }),
        )
        .optional(),
      derived: z.array(z.object({ stop_list_property: name.optional() })).optional(),
    }),
  ),
});

type PackFile = z.infer<typeof packFileSchema>;

function packDirectories(root: string): string[] {
  const folder = join(root, PACKS_FOLDER);
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function propertiesOf(...groups: readonly (readonly (string | undefined)[] | undefined)[]): string[] {
  return groups.flatMap((group) => (group ?? []).filter((name): name is string => name !== undefined && name !== ''));
}

function placeholdersOf(title: string | undefined): string[] {
  return [...(title ?? '').matchAll(TITLE_PLACEHOLDER)].flatMap((match) => (match[1] === undefined || match[1] === '' ? [] : [match[1]]));
}

function identifiersOf(pack: string, file: PackFile): Identifier[] {
  const found = new Map<string, Identifier>();
  const add = (name: string, kind: IdentifierKind): void => {
    found.set(JSON.stringify([name, kind]), { name, kind, pack });
  };
  for (const source of file.sources) {
    for (const entity of source.entities) {
      add(entity.type, 'entity type');
      add(entity.label, 'label');
      const keys = propertiesOf(
        [entity.stable_id, entity.display?.state_property],
        entity.search,
        entity.pii?.map((entry) => (typeof entry === 'string' ? entry : entry.property)),
        entity.filterable,
        entity.reference,
        entity.display?.key_properties,
        entity.degree?.map((entry) => entry.property),
        entity.degree?.map((entry) => entry.observed_at),
        placeholdersOf(entity.title),
      );
      keys.forEach((key) => add(key, 'property key'));
    }
    for (const relationship of source.relationships ?? []) {
      add(relationship.type, 'relationship type');
      propertiesOf([relationship.stable_id, relationship.observed_at], relationship.evidence, relationship.filterable).forEach((key) => add(key, 'property key'));
    }
    propertiesOf((source.derived ?? []).map((rule) => rule.stop_list_property)).forEach((key) => add(key, 'property key'));
  }
  return [...found.values()];
}

function readPackFile(root: string, path: string): PackFile {
  if (!existsSync(join(root, path))) throw new PackError(`${path}: the mapping file is missing`);
  let text: string;
  try {
    text = readFileSync(join(root, path), 'utf8');
  } catch (error) {
    throw new PackError(`${path}: cannot be read (${error instanceof Error && 'code' in error ? String(error.code) : 'unknown error'})`);
  }
  const document = parseDocument(text);
  const [problem] = document.errors;
  if (problem !== undefined) {
    const [position] = problem.linePos ?? [];
    throw new PackError(`${path}: is not valid YAML (${problem.code}${position === undefined ? '' : ` at line ${position.line}, column ${position.col}`})`);
  }
  let data: unknown;
  try {
    data = document.toJS();
  } catch {
    throw new PackError(`${path}: is not valid YAML data (an alias that cannot be resolved or expanded)`);
  }
  const parsed = packFileSchema.safeParse(data);
  if (!parsed.success) {
    const places = parsed.error.issues.map((issue) => issue.path.join('.') || 'the file');
    throw new PackError(`${path}: does not have the shape the check reads, at ${[...new Set(places)].join(', ')}`);
  }
  return parsed.data;
}

export function readIdentifiers(root: string): Identifier[] {
  const packs = packDirectories(root);
  if (packs.length === 0) throw new PackError(`no packs found under ${PACKS_FOLDER}/`);
  return packs.flatMap((pack) => {
    const path = `${PACKS_FOLDER}/${pack}/${MAPPING_FILE}`;
    const identifiers = identifiersOf(pack, readPackFile(root, path));
    if (identifiers.length === 0) throw new PackError(`${path}: has no identifiers to guard`);
    return identifiers;
  });
}
