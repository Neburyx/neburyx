import { canonicalText } from '../questions/canonical.js';
import type { Count, ElementRef, GraphEdge, GraphNode, GraphProperty, ReadRefsResponse } from '@neburyx/contracts';

/**
 * Bytes of UTF-8 text to a token. English text runs near four, so three over-counts and errs toward refusing a view, never toward sending too much; the measured run of the summary's evaluation
 * replaces it with a measured ratio.
 */
export const BYTES_PER_TOKEN_ESTIMATE = 3;

export function estimateTokens(...parts: readonly string[]): number {
  const bytes = parts.reduce((sum, part) => sum + Buffer.byteLength(part, 'utf8'), 0);
  return Math.ceil(bytes / BYTES_PER_TOKEN_ESTIMATE);
}

type ElementKey = { readonly kind: 'entity'; readonly ref: ElementRef } | { readonly kind: 'relationship'; readonly ref: GraphEdge['ref'] };

export interface AssembledText {
  readonly text: string;
  readonly keys: ReadonlyMap<string, ElementKey>;
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
export function assembleText(reading: ReadRefsResponse): AssembledText {
  const keys = new Map<string, ElementKey>();
  let carriesPropertyValues = false;
  const nodes = [...reading.nodes].sort((a, b) => canonicalText(a.ref).localeCompare(canonicalText(b.ref)));
  const edges = [...reading.edges].sort((a, b) => canonicalText(a.ref).localeCompare(canonicalText(b.ref)));
  const nodeKeys = new Map<string, string>();
  const lines: string[] = ['Entities:'];
  nodes.forEach((node: GraphNode, index) => {
    const key = `n${index + 1}`;
    keys.set(key, { kind: 'entity', ref: node.ref });
    nodeKeys.set(canonicalText(node.ref), key);
    const properties = propertiesOf(node.properties);
    carriesPropertyValues ||= properties.carriesValue;
    lines.push(`${key} | ${JSON.stringify(node.display.type)} | title: ${JSON.stringify(node.display.title)} | id: ${JSON.stringify(node.ref.stableId)}${properties.text === '' ? '' : ` | ${properties.text}`}`);
  });
  if (nodes.length === 0) lines.push('(none)');
  lines.push('Relationships:');
  const endOf = (ref: ElementRef): string => nodeKeys.get(canonicalText(ref)) ?? `an end that was not read (${JSON.stringify(ref.entityType)} ${JSON.stringify(ref.stableId)})`;
  edges.forEach((edge, index) => {
    const key = `e${index + 1}`;
    keys.set(key, { kind: 'relationship', ref: edge.ref });
    const properties = propertiesOf(edge.properties);
    carriesPropertyValues ||= properties.carriesValue;
    const parts = [`${key}`, JSON.stringify(edge.type), `${endOf(edge.from)} -> ${endOf(edge.to)}`, edge.semantics, ...times(edge)];
    if (edge.derivation !== undefined) parts.push(`derived by rule ${JSON.stringify(edge.derivation.ruleId)} version ${edge.derivation.ruleVersion}`);
    if (edge.memberCount !== undefined) parts.push(`members: ${countPhrase(edge.memberCount)}`);
    if (properties.text !== '') parts.push(properties.text);
    lines.push(parts.join(' | '));
  });
  if (edges.length === 0) lines.push('(none)');
  const missing = reading.missing.entities.length + reading.missing.edges.length;
  if (missing > 0) lines.push(`${missing} references could not be read.`);
  return { text: lines.join('\n'), keys, carriesPropertyValues };
}
