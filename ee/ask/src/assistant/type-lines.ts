import type { AssistantDescriptionCitation, SummarySentence, TypeDescriptions } from '@neburyx/contracts';
import type { CheckedText } from '@neburyx/ee-ai-runtime';
import type { AssembledText } from '../case-summary/assemble.js';

/** The most meaning lines one call carries; the types of the elements come first, then the types the message names. */
const TYPE_LINES_MAX = 40;

/** The meaning lines of one call: the lines by key, the section of the values that lists them, and the keys. Empty when no type that matters has a description. */
export interface TypeLines {
  readonly lines: ReadonlyMap<string, string>;
  readonly section: string;
  readonly keys: ReadonlySet<string>;
  /** What each line is about, by key, for the citation the server writes. */
  readonly entries: ReadonlyMap<string, Omit<AssistantDescriptionCitation, 'key' | 'kind'>>;
  /** The types in play that have no description, by every name the model may use for them (lower case), to the name of the profile. */
  readonly undescribed: ReadonlyMap<string, string>;
}

const NO_TYPE_LINES: TypeLines = { lines: new Map(), section: '', keys: new Set(), entries: new Map(), undescribed: new Map() };

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentions = (message: string, name: string): boolean => new RegExp(`(?<![\\p{L}\\p{N}_-])${escaped(name)}(?![\\p{L}\\p{N}_-])`, 'iu').test(message);

/** The entity types and the relationship types of the elements of the text sent. */
function typesOf(assembled: AssembledText | undefined): { readonly entities: string[]; readonly relationships: string[] } {
  const entities = new Set<string>();
  const relationships = new Set<string>();
  for (const element of assembled?.keys.values() ?? []) {
    if (element.kind === 'entity') entities.add(element.ref.entityType);
    else if ('type' in element.ref) relationships.add(element.ref.type);
    else if ('aggregate' in element.ref) relationships.add(element.ref.aggregate.type);
  }
  return { entities: [...entities], relationships: [...relationships] };
}

/**
 * The meaning lines of the call, chosen by the server and never by the model: the descriptions of the entity types and relationship types of the elements sent, and of the types the message names (by type, label or
 * display name). One line each, numbered m1, m2, ...: `m1: entity type Account: "..."`, the description written as a JSON string. With no description to send, nothing is added and the values are as they were.
 * The types in play that have no description are kept apart, by every name the model may use for them, so that a reply that says a type has no description can be read.
 */
export function typeLinesOf(descriptions: TypeDescriptions | undefined, assembled: AssembledText | undefined, message: string): TypeLines {
  if (descriptions === undefined) return NO_TYPE_LINES;
  const present = typesOf(assembled);
  const inPlay: { readonly kind: 'entity' | 'relationship'; readonly name: string; readonly aliases: readonly string[]; readonly description: string | undefined }[] = [];
  const add = (kind: 'entity' | 'relationship', name: string, aliases: readonly string[], description: string | undefined): void => {
    if (!inPlay.some((held) => held.kind === kind && held.name === name)) inPlay.push({ kind, name, aliases, description });
  };
  const entities = descriptions.entityTypes.map((entity) => ({ ...entity, aliases: [entity.type, entity.label, entity.displayName] }));
  for (const entity of entities) if (present.entities.includes(entity.type)) add('entity', entity.displayName, entity.aliases, entity.description);
  for (const relationship of descriptions.relationshipTypes) if (present.relationships.includes(relationship.type)) add('relationship', relationship.type, [relationship.type], relationship.description);
  for (const entity of entities) if (entity.aliases.some((name) => mentions(message, name))) add('entity', entity.displayName, entity.aliases, entity.description);
  for (const relationship of descriptions.relationshipTypes) if (mentions(message, relationship.type)) add('relationship', relationship.type, [relationship.type], relationship.description);
  const described = inPlay.flatMap((type) => (type.description === undefined ? [] : [{ ...type, description: type.description }])).slice(0, TYPE_LINES_MAX);
  const undescribed = new Map<string, string>();
  const describedNames = new Set(described.flatMap((type) => type.aliases.map((alias) => alias.toLowerCase())));
  for (const type of inPlay) if (type.description === undefined) for (const alias of type.aliases) if (!describedNames.has(alias.toLowerCase())) undescribed.set(alias.toLowerCase(), type.name);
  if (described.length === 0 && undescribed.size === 0) return NO_TYPE_LINES;
  const lines = new Map(described.map((line, index) => [`m${index + 1}`, `m${index + 1}: ${line.kind} type ${line.name}: ${JSON.stringify(line.description)}`] as const));
  const entries = new Map(described.map((line, index) => [`m${index + 1}`, { typeKind: line.kind, type: line.name, description: line.description }] as const));
  const section = lines.size === 0 ? '' : `\n\nWhat the types mean (plain descriptions the operator wrote; cite an m line to say what a type means, never as evidence about a record):\n${[...lines.values()].join('\n')}`;
  return { lines, keys: new Set(lines.keys()), entries, undescribed, section };
}

/** The fixed sentence of a question about types the mapping does not describe, written from the names of the profile and never from the model's words. */
export function noDescriptionSentence(names: readonly string[]): string {
  if (names.length === 1) return `The mapping has no description for ${names[0] ?? ''}, so I cannot say what it means.`;
  return `The mapping has no description for ${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''}, so I cannot say what they mean.`;
}

/**
 * The profile names of the types a reply says have no description, once each, in the order the reply gave them; undefined when the reply names nothing, or names a type that is not in play or has a description. A name
 * matches the type, the label or the display name, whatever its case. A name is looked up, never used as a key of an object.
 */
export function undescribedNamesOf(requested: readonly string[], typeLines: TypeLines): readonly string[] | undefined {
  if (requested.length === 0 || requested.length > TYPE_LINES_MAX) return undefined;
  const found: string[] = [];
  for (const requestedName of requested) {
    const name = typeLines.undescribed.get(requestedName.trim().toLowerCase());
    if (name === undefined) return undefined;
    if (!found.includes(name)) found.push(name);
  }
  return found;
}

/** The checked text with the meaning lines added: their keys are known keys, their lines are in the lines, and they are marked as meanings. */
export function withTypeLines(checked: CheckedText, typeLines: TypeLines): CheckedText {
  if (typeLines.keys.size === 0) return checked;
  return {
    ...checked,
    keys: new Map([...checked.keys, ...[...typeLines.keys].map((key) => [key, true] as const)]),
    lines: new Map([...checked.lines, ...typeLines.lines]),
    descriptionKeys: typeLines.keys,
  };
}

/** The citations of the meaning lines the kept sentences cite, once each in the order cited: what the server wrote into the call, never what the model wrote. */
export function descriptionCitationsOf(kept: readonly SummarySentence[], typeLines: TypeLines): AssistantDescriptionCitation[] {
  const seen = new Set<string>();
  const out: AssistantDescriptionCitation[] = [];
  for (const key of kept.flatMap((sentence) => sentence.cites)) {
    const entry = typeLines.entries.get(key);
    if (entry === undefined || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, kind: 'description', ...entry });
  }
  return out;
}

/** The profile names of a reply that is exactly `{"noDescription":["<Type>", ...]}` and names only types in play that have no description; undefined for any other reply. */
export function noDescriptionReplyOf(text: string, typeLines: TypeLines): readonly string[] | undefined {
  if (typeLines.undescribed.size === 0) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json) || Object.keys(json).join() !== 'noDescription') return undefined;
  const named = (json as { readonly noDescription?: unknown }).noDescription;
  if (!Array.isArray(named) || !named.every((name): name is string => typeof name === 'string')) return undefined;
  return undescribedNamesOf(named, typeLines);
}
