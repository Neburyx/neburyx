import { storedAiNotesEntrySchema, type EdgeRef, type ElementRef, type ElementRefs, type GraphEdge, type GraphNode, type StoredAiNotesEntry, type SummaryReading } from '@neburyx/contracts';
import { EXPORT_HIDDEN_NOTE } from '@neburyx/contracts';
import { canonicalText } from '../questions/canonical.js';
import { countPhrase } from './assemble.js';
import type { Descriptor } from './notes-convert.js';

export type StoredEntry = StoredAiNotesEntry;

/** An entry as stored, checked against the shared schema: a stored value that does not fit it is left out and never shown. */
export function parseStoredEntry(value: unknown): StoredEntry | undefined {
  const parsed = storedAiNotesEntrySchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

const descriptorRefs = (descriptor: Descriptor): readonly (ElementRef | EdgeRef)[] => {
  switch (descriptor.kind) {
    case 'entity':
      return [descriptor.ref];
    case 'type':
      return [descriptor.of.ref];
    case 'count':
    case 'time':
      return [descriptor.relationship];
    case 'value':
      return descriptor.of.map((owner) => owner.ref);
    case 'tally':
      return descriptor.of;
  }
};

/** Every element the entries sent, cite or name, by kind of reference, once each: the one batch a read of the notes re-reads for the viewer. */
export function refsOf(entries: readonly StoredEntry[]): ElementRefs {
  const entities = new Map<string, ElementRef>();
  const edges = new Map<string, Extract<EdgeRef, { stableId: string }>>();
  const aggregates = new Map<string, Extract<EdgeRef, { aggregate: unknown }>>();
  const derived = new Map<string, Extract<EdgeRef, { derived: unknown }>>();
  const add = (ref: ElementRef | EdgeRef): void => {
    const key = canonicalText(ref);
    if ('entityType' in ref) entities.set(key, ref);
    else if ('stableId' in ref) edges.set(key, ref);
    else if ('aggregate' in ref) aggregates.set(key, ref);
    else derived.set(key, ref);
  };
  for (const entry of entries) {
    entry.inputRefs.forEach((sent) => add(sent.ref));
    for (const sentence of entry.sentences) {
      for (const placeholder of sentence.placeholders) descriptorRefs(placeholder.descriptor).forEach(add);
      sentence.cites.forEach((cite) => add(cite.ref));
    }
  }
  return { entities: [...entities.values()], edges: [...edges.values()], aggregates: [...aggregates.values()], derived: [...derived.values()] };
}

interface RebuiltCitation {
  readonly kind: 'entity' | 'relationship';
  readonly ref: ElementRef | EdgeRef;
  readonly title: string;
  readonly type: string;
}

interface RebuiltSentence {
  readonly text: string;
  readonly citations: readonly RebuiltCitation[];
}

export interface RebuiltEntry {
  readonly tokenId: string;
  readonly modelRef: string;
  readonly generatedAt: string;
  readonly label: string;
  readonly sentences: readonly RebuiltSentence[];
  /** What the viewer's re-read left out of the elements this summary was made from, counted from the entry's own elements. */
  readonly coverage: string;
}

const titleOf = (node: GraphNode): string => (node.display.title === '' ? node.ref.stableId : node.display.title);

const endTitle = (nodes: ReadonlyMap<string, GraphNode>, ref: ElementRef): string => {
  const found = nodes.get(canonicalText(ref));
  return found === undefined ? ref.stableId : titleOf(found);
};

/**
 * Rebuilds the sentences of an entry from what the viewer's own re-read returned: each placeholder is resolved for the viewer, with their masking, their member-count phrase and their quality label. A sentence that cites or names
 * an element the viewer cannot see, or whose count is not known or whose time field is absent for them, is left out, silently. The coverage line counts the elements this summary was made from that the viewer is shown.
 */
export function rebuildEntry(entry: StoredEntry, reading: SummaryReading): RebuiltEntry {
  const nodes = new Map(reading.nodes.map((node) => [canonicalText(node.ref), node]));
  const edges = new Map(reading.edges.map((edge) => [canonicalText(edge.ref), edge]));
  const node = (ref: ElementRef): GraphNode | undefined => nodes.get(canonicalText(ref));
  const edge = (ref: EdgeRef): GraphEdge | undefined => edges.get(canonicalText(ref));
  const resolve = (descriptor: Descriptor): string | undefined => {
    switch (descriptor.kind) {
      case 'entity': {
        const found = node(descriptor.ref);
        return found === undefined ? undefined : titleOf(found);
      }
      case 'type':
        return descriptor.of.kind === 'entity' ? node(descriptor.of.ref)?.display.type : edge(descriptor.of.ref)?.type;
      case 'count': {
        const count = edge(descriptor.relationship)?.memberCount;
        return count === undefined || count.value === undefined || count.quality === 'unknown' ? undefined : countPhrase(count);
      }
      case 'value': {
        const shown = descriptor.of.map((owner) => (owner.kind === 'entity' ? node(owner.ref)?.properties : edge(owner.ref)?.properties)?.find((property) => property.key === descriptor.key));
        const texts = shown.map((property) => (property === undefined || (typeof property.value !== 'string' && typeof property.value !== 'number') ? undefined : String(property.value)));
        const [first] = texts;
        return first === undefined || texts.some((text) => text !== first) ? undefined : first;
      }
      case 'tally': {
        const found = descriptor.of.map((ref) => node(ref));
        const [head] = found;
        if (head === undefined || found.some((entity) => entity === undefined || entity.display.type !== head.display.type)) return undefined;
        return `${found.length} ${head.display.type.toLowerCase()}${descriptor.suffix}`;
      }
      case 'time': {
        const value = edge(descriptor.relationship)?.[descriptor.field];
        return typeof value === 'string' && value !== '' ? value : undefined;
      }
    }
  };
  const sentences: RebuiltSentence[] = [];
  for (const sentence of entry.sentences) {
    let rebuilt = sentence.text;
    let whole = true;
    for (const placeholder of sentence.placeholders) {
      const value = resolve(placeholder.descriptor);
      if (value === undefined) {
        whole = false;
        break;
      }
      rebuilt = rebuilt.split(placeholder.name).join(value);
    }
    const citations: RebuiltCitation[] = [];
    for (const cite of sentence.cites) {
      if (!whole) break;
      if (cite.kind === 'entity') {
        const found = node(cite.ref);
        if (found === undefined) whole = false;
        else citations.push({ kind: 'entity', ref: found.ref, title: titleOf(found), type: found.display.type });
      } else {
        const found = edge(cite.ref);
        if (found === undefined) whole = false;
        else citations.push({ kind: 'relationship', ref: found.ref, title: `${endTitle(nodes, found.from)} → ${endTitle(nodes, found.to)}`, type: found.type });
      }
    }
    if (whole) sentences.push({ text: rebuilt, citations });
  }
  const shown = entry.inputRefs.filter((sent) => (sent.kind === 'entity' ? node(sent.ref) !== undefined : edge(sent.ref) !== undefined)).length;
  const total = entry.inputRefs.length;
  const coverage = `${shown.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} elements this summary was made from are shown to you${shown < total && reading.omitted ? ` · ${EXPORT_HIDDEN_NOTE}` : ''}`;
  return { tokenId: entry.tokenId, modelRef: entry.modelRef, generatedAt: entry.generatedAt, label: entry.label, sentences, coverage };
}
