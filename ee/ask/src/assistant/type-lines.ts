import type { AssistantDescriptionCitation, SummarySentence, TypeDescriptions } from '@neburyx/contracts';
import type { CheckedText } from '@neburyx/ee-ai-runtime';
import type { AssembledText } from '../case-summary/assemble.js';

/** The most meaning lines one call carries; the types of the elements come first, then the types the message names. */
export const TYPE_LINES_MAX = 40;

/** The meaning lines of one call: the lines by key, the section of the values that lists them, and the keys. Empty when no type that matters has a description. */
export interface TypeLines {
  readonly lines: ReadonlyMap<string, string>;
  readonly section: string;
  readonly keys: ReadonlySet<string>;
  /** What each line is about, by key, for the citation the server writes. */
  readonly entries: ReadonlyMap<string, Omit<AssistantDescriptionCitation, 'key' | 'kind'>>;
}

export const NO_TYPE_LINES: TypeLines = { lines: new Map(), section: '', keys: new Set(), entries: new Map() };

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
 */
export function typeLinesOf(descriptions: TypeDescriptions | undefined, assembled: AssembledText | undefined, message: string): TypeLines {
  if (descriptions === undefined || (descriptions.entityTypes.length === 0 && descriptions.relationshipTypes.length === 0)) return NO_TYPE_LINES;
  const present = typesOf(assembled);
  const chosen: { readonly kind: 'entity' | 'relationship'; readonly name: string; readonly description: string }[] = [];
  const add = (kind: 'entity' | 'relationship', name: string, description: string): void => {
    if (!chosen.some((held) => held.kind === kind && held.name === name)) chosen.push({ kind, name, description });
  };
  for (const entity of descriptions.entityTypes) if (present.entities.includes(entity.type)) add('entity', entity.displayName, entity.description);
  for (const relationship of descriptions.relationshipTypes) if (present.relationships.includes(relationship.type)) add('relationship', relationship.type, relationship.description);
  for (const entity of descriptions.entityTypes) if ([entity.type, entity.label, entity.displayName].some((name) => mentions(message, name))) add('entity', entity.displayName, entity.description);
  for (const relationship of descriptions.relationshipTypes) if (mentions(message, relationship.type)) add('relationship', relationship.type, relationship.description);
  const lines = new Map(chosen.slice(0, TYPE_LINES_MAX).map((line, index) => [`m${index + 1}`, `m${index + 1}: ${line.kind} type ${line.name}: ${JSON.stringify(line.description)}`] as const));
  if (lines.size === 0) return NO_TYPE_LINES;
  const entries = new Map(chosen.slice(0, TYPE_LINES_MAX).map((line, index) => [`m${index + 1}`, { typeKind: line.kind, type: line.name, description: line.description }] as const));
  return { lines, keys: new Set(lines.keys()), entries, section: `\n\nWhat the types mean (plain descriptions the operator wrote; cite an m line to say what a type means, never as evidence about a record):\n${[...lines.values()].join('\n')}` };
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
