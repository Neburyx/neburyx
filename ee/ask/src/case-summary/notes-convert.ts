import { AI_NOTES_MAX_SLOTS, AI_NOTES_TIME_FIELDS, type AiNotesDescriptor, type AiNotesPlaceholder, type EdgeRef, type ElementRef, type GraphEdge, type GraphNode, type GraphProperty, type SummaryReading, type SummarySentence } from '@neburyx/contracts';
import { canonicalText } from '../questions/canonical.js';
import { countPhrase, type AssembledText } from './assemble.js';
import { checkStorable, type NotStorableReason } from './notes-rule.js';

export type Descriptor = AiNotesDescriptor;

type Placeholder = AiNotesPlaceholder;

/** What a sentence becomes as AI notes: the text to store with its placeholders, or the reason it cannot be stored. Made when the draft is made and sealed in its token. */
export type NotesTemplate = { readonly storable: true; readonly text: string; readonly placeholders: readonly Placeholder[] } | { readonly storable: false; readonly reason: NotStorableReason };

const OPEN = '\uE000';
const CLOSE = '\uE001';
const SLOT_BASE = 0xe100;
const SENTINEL = /\uE000([\uE100-\uF8FE])\uE001/gu;

/** A mark left in the text where a slot was cut out. It holds no letter or digit, so no later search of the text can match it. */
const markOf = (index: number): string => `${OPEN}${String.fromCharCode(SLOT_BASE + index)}${CLOSE}`;

interface Needle {
  readonly value: string;
  readonly keys: readonly string[];
}

/** The value as a whole token of the text, whatever its case: a name inside a longer word is left for the storage rule, which refuses it. */
const wholeToken = (value: string, flags = 'iu'): RegExp => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(value)}(?![\\p{L}\\p{N}])`, flags);

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** The texts a property value says: a string of more than one character, a number, and those inside a list or an object. */
function textsOf(value: unknown): string[] {
  if (typeof value === 'string') return value.length > 1 ? [value] : [];
  if (typeof value === 'number' || typeof value === 'bigint') return [String(value)];
  if (Array.isArray(value)) return value.flatMap(textsOf);
  return typeof value === 'object' && value !== null ? Object.values(value).flatMap(textsOf) : [];
}

function valuesOf(properties: readonly GraphProperty[]): string[] {
  return properties.flatMap((property) => textsOf(property.value));
}

type Owner = { readonly kind: 'entity'; readonly ref: ElementRef } | { readonly kind: 'relationship'; readonly ref: EdgeRef };

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];

/** The ways a count is written as one token: its digits and, up to twenty, its word. */
const numberTokens = (count: number): string[] => [String(count), ...(NUMBER_WORDS[count] === undefined ? [] : [NUMBER_WORDS[count]])];

/** The scalar property values of an element a sentence can state: a string of more than one character, or a number. A list, an object and a flag are left to the storage rule. */
function scalarsOf(properties: readonly GraphProperty[]): { readonly key: string; readonly text: string }[] {
  return properties.flatMap((property) => (typeof property.value === 'string' && property.value.length > 1 ? [{ key: property.key, text: property.value }] : typeof property.value === 'number' ? [{ key: property.key, text: String(property.value) }] : []));
}

const kindWord = (typeName: string): string => {
  const word = typeName.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '');
  return /^[a-z]/u.test(word) ? word : 'entity';
};

/**
 * Converts each sentence of a draft, with the whole reading of the generation in hand: the title and stable id of a cited entity become an entity placeholder, the type name of a cited element a type placeholder, the member-count phrase or an
 * observed or valid time of exactly one cited relationship a count or a time slot (a binding that is not unique is refused); the title or id of any
 * element that was sent but not cited, a title that two elements share, and any value of a property that was sent, make the sentence not storable; what is left must be listed words (the storage rule). The placeholders are numbered
 * across the whole draft, so one entity has one name in every sentence.
 */
export function templatesOf(sentences: readonly SummarySentence[], assembled: AssembledText, reading: SummaryReading): readonly NotesTemplate[] {
  const nodeByRef = new Map(reading.nodes.map((node) => [canonicalText(node.ref), node]));
  const edgeByRef = new Map(reading.edges.map((edge) => [canonicalText(edge.ref), edge]));
  const entities = new Map<string, { readonly node: GraphNode; readonly ref: ElementRef }>();
  const relationships = new Map<string, { readonly edge: GraphEdge; readonly ref: EdgeRef }>();
  for (const [key, element] of assembled.keys) {
    if (element.kind === 'entity') {
      const node = nodeByRef.get(canonicalText(element.ref));
      if (node !== undefined) entities.set(key, { node, ref: node.ref });
    } else {
      const edge = edgeByRef.get(canonicalText(element.ref));
      if (edge !== undefined) relationships.set(key, { edge, ref: edge.ref });
    }
  }
  const owners = new Map<string, { readonly value: string; readonly keys: string[] }>();
  for (const [key, { node }] of entities) {
    for (const name of new Set([node.display.title, node.ref.stableId])) {
      if (name === '') continue;
      const known = owners.get(name.toLowerCase());
      if (known === undefined) owners.set(name.toLowerCase(), { value: name, keys: [key] });
      else if (!known.keys.includes(key)) known.keys.push(key);
    }
  }
  const needles: Needle[] = [...owners.values()].sort((a, b) => b.value.length - a.value.length);
  const propertyValues = [...new Set([...reading.nodes.flatMap((node) => valuesOf(node.properties)), ...reading.edges.flatMap((edge) => valuesOf(edge.properties))])];
  const counters = new Map<string, number>();
  const names = new Map<string, string>();
  const nameOf = (id: string, kind: string): string => {
    const known = names.get(id);
    if (known !== undefined) return known;
    const next = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, next);
    const made = `‹${kind}#${next}›`;
    names.set(id, made);
    return made;
  };

  return sentences.map((sentence): NotesTemplate => {
    if (/[‹›]/u.test(sentence.text)) return { storable: false, reason: 'unlisted-word' };
    const cited = new Set(sentence.cites);
    if (cited.size > AI_NOTES_MAX_SLOTS) return { storable: false, reason: 'bound' };
    const slots: { readonly placeholder: Placeholder }[] = [];
    let text = sentence.text;
    const citedEdges = [...cited].flatMap((key) => relationships.get(key) ?? []);
    const phrases = new Map<string, EdgeRef[]>();
    for (const { edge, ref } of citedEdges) if (edge.memberCount !== undefined && edge.memberCount.value !== undefined && edge.memberCount.quality !== 'unknown') phrases.set(countPhrase(edge.memberCount), [...(phrases.get(countPhrase(edge.memberCount)) ?? []), ref]);
    if (/(?<![\p{L}\p{N}])not known(?![\p{L}\p{N}])/iu.test(text)) return { storable: false, reason: 'number-or-date' };
    for (const [phrase, refs] of [...phrases].sort((a, b) => b[0].length - a[0].length)) {
      if (!text.includes(phrase)) continue;
      const [only] = refs;
      if (refs.length !== 1 || only === undefined) return { storable: false, reason: 'number-or-date' };
      text = text.split(phrase).join(markOf(slots.length));
      slots.push({ placeholder: { name: nameOf(`count:${canonicalText(only)}`, 'count'), descriptor: { kind: 'count', relationship: only, scope: 'members' } } });
    }
    const times = new Map<string, Descriptor[]>();
    for (const { edge, ref } of citedEdges) for (const field of AI_NOTES_TIME_FIELDS) {
      const value = edge[field];
      if (typeof value === 'string' && value !== '') times.set(value, [...(times.get(value) ?? []), { kind: 'time', relationship: ref, field }]);
    }
    for (const [value, owners] of [...times].sort((a, b) => b[0].length - a[0].length)) {
      if (!text.includes(value)) continue;
      const [only] = owners;
      if (owners.length !== 1 || only === undefined || only.kind !== 'time' || propertyValues.includes(value)) return { storable: false, reason: 'number-or-date' };
      text = text.split(value).join(markOf(slots.length));
      slots.push({ placeholder: { name: nameOf(`time:${canonicalText(only)}`, 'time'), descriptor: only } });
    }
    const typed = new Map<string, ElementRef[]>();
    for (const key of cited) {
      const entity = entities.get(key);
      if (entity !== undefined) typed.set(entity.node.display.type, [...(typed.get(entity.node.display.type) ?? []), entity.ref]);
    }
    for (const [typeName, refs] of typed) {
      if (typeName === '' || refs.length > AI_NOTES_MAX_SLOTS) continue;
      const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(${numberTokens(refs.length).join('|')})\\s+${escapeRegExp(typeName)}(es|s)?(?![\\p{L}\\p{N}])`, 'iu');
      for (let found = pattern.exec(text); found !== null; found = pattern.exec(text)) {
        const suffix = (found[2] ?? '').toLowerCase() as '' | 's' | 'es';
        text = text.replace(pattern, markOf(slots.length));
        slots.push({ placeholder: { name: nameOf(`tally:${typeName}:${refs.map(canonicalText).join(',')}:${suffix}`, 'count'), descriptor: { kind: 'tally', of: refs, suffix } } });
      }
    }
    for (const needle of needles) {
      if (!wholeToken(needle.value).test(text)) continue;
      const [only, ...more] = needle.keys;
      const entity = only === undefined ? undefined : entities.get(only);
      if (more.length > 0 || entity === undefined || !cited.has(only ?? '')) return { storable: false, reason: 'name' };
      const placeholder: Placeholder = { name: nameOf(`entity:${only}`, kindWord(entity.node.display.type)), descriptor: { kind: 'entity', ref: entity.ref } };
      text = text.replace(wholeToken(needle.value, 'giu'), markOf(slots.length));
      slots.push({ placeholder });
    }
    const seenTypes = new Set<string>();
    for (const key of cited) {
      const entity = entities.get(key);
      const relationship = relationships.get(key);
      const typeName = entity?.node.display.type ?? relationship?.edge.type;
      if (typeName === undefined || typeName === '' || seenTypes.has(typeName)) continue;
      const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(typeName)}(?![\\p{L}\\p{N}])`, 'giu');
      if (!new RegExp(pattern.source, 'iu').test(text)) continue;
      seenTypes.add(typeName);
      const of = entity !== undefined ? ({ kind: 'entity', ref: entity.ref } as const) : relationship !== undefined ? ({ kind: 'relationship', ref: relationship.ref } as const) : undefined;
      if (of === undefined) continue;
      const placeholder: Placeholder = { name: nameOf(`type:${typeName}`, 'type'), descriptor: { kind: 'type', of } };
      text = text.replace(new RegExp(pattern.source, pattern.flags), markOf(slots.length));
      slots.push({ placeholder });
    }
    const holders = new Map<string, { readonly value: string; readonly byKey: Map<string, Owner[]>; nonScalar: boolean }>();
    for (const key of cited) {
      const owner = entities.get(key) ?? relationships.get(key);
      if (owner === undefined) continue;
      const element: Owner = 'node' in owner ? { kind: 'entity', ref: owner.ref } : { kind: 'relationship', ref: owner.ref };
      for (const property of 'node' in owner ? owner.node.properties : owner.edge.properties) {
        const scalar = scalarsOf([property]);
        const texts = scalar.length > 0 ? scalar.map((one) => one.text) : textsOf(property.value);
        for (const value of texts) {
          const known = holders.get(value.toLowerCase()) ?? { value, byKey: new Map<string, Owner[]>(), nonScalar: false };
          if (scalar.length > 0) known.byKey.set(property.key, [...(known.byKey.get(property.key) ?? []), element]);
          else {
            known.nonScalar = true;
            known.byKey.set(property.key, known.byKey.get(property.key) ?? []);
          }
          holders.set(value.toLowerCase(), known);
        }
      }
    }
    for (const { value, byKey, nonScalar } of [...holders.values()].sort((a, b) => b.value.length - a.value.length)) {
      if (!wholeToken(value).test(text)) continue;
      const groups = [...byKey];
      const [group] = groups;
      if (nonScalar || groups.length !== 1 || group === undefined) return { storable: false, reason: 'property-value' };
      if (group[1].length > AI_NOTES_MAX_SLOTS) return { storable: false, reason: 'bound' };
      const [property, owners] = group;
      text = text.replace(wholeToken(value, 'giu'), markOf(slots.length));
      slots.push({ placeholder: { name: nameOf(`value:${property}:${owners.map((owner) => canonicalText(owner.ref)).join(',')}`, 'value'), descriptor: { kind: 'value', of: owners, key: property } } });
    }
    for (const value of propertyValues) {
      if (wholeToken(value).test(text)) return { storable: false, reason: 'property-value' };
    }
    const used: Placeholder[] = [];
    const stored = text.replace(SENTINEL, (_whole, index: string) => {
      const slot = slots[index.charCodeAt(0) - SLOT_BASE];
      if (slot === undefined) return '';
      if (!used.some((placeholder) => placeholder.name === slot.placeholder.name)) used.push(slot.placeholder);
      return slot.placeholder.name;
    });
    const checked = checkStorable(stored, new Set(used.map((placeholder) => placeholder.name)));
    if (used.length > AI_NOTES_MAX_SLOTS) return { storable: false, reason: 'bound' };
    return checked.storable ? { storable: true, text: stored, placeholders: used } : { storable: false, reason: checked.reason };
  });
}

/** The sentence with whether it can be stored as AI notes and, when not, which of the three groups of reason says why. */
export function storableMarkOf(sentence: SummarySentence, template: NotesTemplate | undefined): SummarySentence & { readonly storable: boolean; readonly notStorable?: 'number' | 'value' | 'word' } {
  if (template?.storable === true) return { ...sentence, storable: true };
  const reason = template?.reason;
  if (reason === 'bound' || reason === undefined) return { ...sentence, storable: false };
  return { ...sentence, storable: false, notStorable: reason === 'number-or-date' ? 'number' : reason === 'name' || reason === 'property-value' ? 'value' : 'word' };
}
