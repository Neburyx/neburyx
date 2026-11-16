import { canonicalText } from '../questions/canonical.js';
import type { Count, ElementRef, GraphEdge, GraphNode, GraphProperty, SummaryReading } from '@neburyx/contracts';

/**
 * Bytes of UTF-8 text to a token, measured on the views and samples of `tools/summary-suite` (1.81 for 300 bare elements, the smallest of the samples up to 300 elements). The smallest ratio counts the most tokens, so
 * up to about 300 elements the estimate errs toward refusing a view; a much larger element cap under-counts slightly.
 */
export const BYTES_PER_TOKEN_ESTIMATE = 1.8;

export function estimateTokens(...parts: readonly string[]): number {
  const bytes = parts.reduce((sum, part) => sum + Buffer.byteLength(part, 'utf8'), 0);
  return Math.ceil(bytes / BYTES_PER_TOKEN_ESTIMATE);
}

type ElementKey = { readonly kind: 'entity'; readonly ref: ElementRef } | { readonly kind: 'relationship'; readonly ref: GraphEdge['ref'] };

/** A count of an element that is not exact, as the text writes it: the sentence that states its number must copy the phrase. */
interface InexactCount {
  readonly phrase: string;
  readonly value: string;
}

export interface AssembledText {
  readonly text: string;
  readonly keys: ReadonlyMap<string, ElementKey>;
  /** The line of each element, by key. */
  readonly lines: ReadonlyMap<string, string>;
  readonly inexactCounts: readonly InexactCount[];
  /** The keys of the elements whose count the text gives as not known. */
  readonly unknownCountKeys: ReadonlySet<string>;
  /** Whether any line carries the value of a property of an element, masked or not, as opposed to its name, type and structure. */
  readonly carriesPropertyValues: boolean;
}

/** A count as a ready phrase with its quality, so the model copies a label and computes none. */
export function countPhrase(count: Count): string {
  if (count.quality === 'unknown' || count.value === undefined) return 'not known';
  switch (count.quality) {
    case 'exact':
      return `${count.value} (exact)`;
    case 'estimated':
      return `~${count.value} (estimated)`;
    case 'lowerBound':
      return `≥ ${count.value} (lower bound)`;
  }
}

function propertiesOf(properties: readonly GraphProperty[]): { readonly text: string; readonly carriesValue: boolean } {
  let carriesValue = false;
  const parts = properties.map((property) => {
    if (property.value === undefined) return `${property.key}: (not shown)`;
    carriesValue = true;
    return `${property.key}: ${JSON.stringify(property.value)}${property.masked ? ' (masked)' : ''}`;
  });
  return { text: parts.join('; '), carriesValue };
}

const times = (edge: GraphEdge): string[] => {
  const parts: string[] = [];
  if (edge.observedAt !== undefined) parts.push(`observed at ${JSON.stringify(edge.observedAt)}`);
  if (edge.observedFirst !== undefined || edge.observedLast !== undefined) parts.push(`observed ${JSON.stringify(edge.observedFirst ?? '?')} to ${JSON.stringify(edge.observedLast ?? '?')}`);
  if (edge.validFrom !== undefined || edge.validTo !== undefined) parts.push(`valid ${JSON.stringify(edge.validFrom ?? '?')} to ${JSON.stringify(edge.validTo ?? '?')}`);
  return parts;
};

/**
 * The one text a summary call is given, built from what the gate returned: entities keyed `n1`…, relationships keyed `e1`…, in the order of their references so the same input gives the same text.
 * Strings are quoted, so what an element says stays a value on its own line. An end of a relationship that was not read has no key and cannot be cited.
 */
export function assembleText(reading: SummaryReading): AssembledText {
  const keys = new Map<string, ElementKey>();
  const lines = new Map<string, string>();
  const inexactCounts: InexactCount[] = [];
  const unknownCountKeys = new Set<string>();
  let carriesPropertyValues = false;
  const nodes = [...reading.nodes].sort((a, b) => canonicalText(a.ref).localeCompare(canonicalText(b.ref)));
  const edges = [...reading.edges].sort((a, b) => canonicalText(a.ref).localeCompare(canonicalText(b.ref)));
  const nodeKeys = new Map<string, string>();
  const out: string[] = ['Entities:'];
  nodes.forEach((node: GraphNode, index) => {
    const key = `n${index + 1}`;
    keys.set(key, { kind: 'entity', ref: node.ref });
    nodeKeys.set(canonicalText(node.ref), key);
    const properties = propertiesOf(node.properties);
    carriesPropertyValues ||= properties.carriesValue;
    const line = `${key} | ${JSON.stringify(node.display.type)} | title: ${JSON.stringify(node.display.title)} | id: ${JSON.stringify(node.ref.stableId)}${properties.text === '' ? '' : ` | ${properties.text}`}`;
    lines.set(key, line);
    out.push(line);
  });
  if (nodes.length === 0) out.push('(none)');
  out.push('Relationships:');
  const endOf = (ref: ElementRef): string => nodeKeys.get(canonicalText(ref)) ?? `an end that was not read (${JSON.stringify(ref.entityType)} ${JSON.stringify(ref.stableId)})`;
  edges.forEach((edge, index) => {
    const key = `e${index + 1}`;
    keys.set(key, { kind: 'relationship', ref: edge.ref });
    const properties = propertiesOf(edge.properties);
    carriesPropertyValues ||= properties.carriesValue;
    const parts = [`${key}`, JSON.stringify(edge.type), `${endOf(edge.from)} -> ${endOf(edge.to)}`, edge.semantics, ...times(edge)];
    if (edge.derivation !== undefined) parts.push(`derived by rule ${JSON.stringify(edge.derivation.ruleId)} version ${edge.derivation.ruleVersion}`);
    if (edge.memberCount !== undefined) {
      const phrase = countPhrase(edge.memberCount);
      parts.push(`members: ${phrase}`);
      if (edge.memberCount.quality === 'unknown' || edge.memberCount.value === undefined) unknownCountKeys.add(key);
      else if (edge.memberCount.quality !== 'exact') inexactCounts.push({ phrase, value: String(edge.memberCount.value) });
    }
    if (properties.text !== '') parts.push(properties.text);
    const line = parts.join(' | ');
    lines.set(key, line);
    out.push(line);
  });
  if (edges.length === 0) out.push('(none)');
  if (reading.unresolved > 0) out.push(`${reading.unresolved} references could not be read.`);
  return { text: out.join('\n'), keys, lines, inexactCounts, unknownCountKeys, carriesPropertyValues };
}
