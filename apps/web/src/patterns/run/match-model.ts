import { formatNumber } from '../../workspace/scope-text.js';
import type { ElementRef, GraphEdge, GraphNode, PatternHop, PatternMatch, PatternRunOk, GraphProperty } from '@neburyx/contracts';
import { edgeKey, elementKey } from '../../state/keys.js';
import { RUN_COPY } from './run-copy.js';

export type PathPart = { readonly kind: 'entity'; readonly text: string; readonly gap: boolean } | { readonly kind: 'relationship'; readonly text: string };

const keyOf = (ref: ElementRef | null): string | undefined => (ref === null ? undefined : elementKey(ref));

/** The path that reached a match, as parts: an entity (a gap kept where it has no usable ID) and the relationship of each hop between. */
export function pathOf(match: PatternMatch, answer: PatternRunOk, mask: boolean): readonly PathPart[] {
  const titles = new Map(answer.nodes.map((node) => [elementKey(node.ref), node.display.title]));
  const entity = (ref: ElementRef | null | undefined): PathPart => {
    if (ref === null || ref === undefined) return { kind: 'entity', text: RUN_COPY.gap, gap: true };
    const title = titles.get(elementKey(ref));
    // an ID can be a personal-data value, so it is not the fallback while masking is on
    return { kind: 'entity', text: title ?? (mask ? RUN_COPY.hiddenEntity : ref.stableId), gap: false };
  };
  const first = match.relationships[0]?.from;
  const parts: PathPart[] = [entity(first)];
  match.relationships.forEach((hop, index) => {
    parts.push({ kind: 'relationship', text: hop.relationshipType ?? RUN_COPY.unusableRelationship });
    parts.push(entity(index < match.through.length ? match.through[index] : match.match));
  });
  return parts;
}

const hopEdges = (hop: PatternHop, edges: readonly GraphEdge[]): readonly GraphEdge[] =>
  edges.filter((edge) => {
    if (hop.relationshipType !== null && edge.type !== hop.relationshipType) return false;
    if (hop.stableId !== undefined && 'stableId' in edge.ref) return edge.ref.stableId === hop.stableId;
    const from = keyOf(hop.from);
    const to = keyOf(hop.to);
    if (from === undefined || to === undefined) return false;
    const edgeFrom = elementKey(edge.from);
    const edgeTo = elementKey(edge.to);
    return (edgeFrom === from && edgeTo === to) || (edgeFrom === to && edgeTo === from);
  });

/** The relationships of the answer that one match was reached by. */
export function edgesOfMatch(match: PatternMatch, answer: PatternRunOk): readonly GraphEdge[] {
  const seen = new Set<string>();
  const found: GraphEdge[] = [];
  for (const edge of match.relationships.flatMap((hop) => hopEdges(hop, answer.edges))) {
    const key = edgeKey(edge.ref);
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(edge);
  }
  return found;
}

/** The entities and relationships of one match, from what the answer holds. */
export function partOf(match: PatternMatch, answer: PatternRunOk): { readonly nodes: readonly GraphNode[]; readonly edges: readonly GraphEdge[] } {
  const keys = new Set<string>([elementKey(match.match)]);
  for (const ref of match.through) if (ref !== null) keys.add(elementKey(ref));
  for (const hop of match.relationships) {
    for (const ref of [hop.from, hop.to]) if (ref !== null) keys.add(elementKey(ref));
  }
  return { nodes: answer.nodes.filter((node) => keys.has(elementKey(node.ref))), edges: edgesOfMatch(match, answer) };
}

const PERSONAL_CLASSES: ReadonlySet<GraphProperty['dataClass']> = new Set(['name', 'email', 'phone']);

const valueText = (value: unknown): string | undefined => (typeof value === 'string' ? value : typeof value === 'number' ? formatNumber(value) : typeof value === 'boolean' ? String(value) : undefined);

/** A line for each property the answer carries; a value that is masked, or a personal-data one (by its class or by the mapping's list for the type) while masking is on, is left out. */
function linesOfProperties(owner: string, properties: readonly GraphProperty[], mask: boolean, personal: readonly string[]): readonly string[] {
  return properties.flatMap((property) => {
    if (property.masked || (mask && (PERSONAL_CLASSES.has(property.dataClass) || personal.includes(property.key)))) return [];
    const value = valueText(property.value);
    return value === undefined ? [] : [`${owner}: ${property.key} is ${value}`];
  });
}

/** The lines a match carries: the properties of the entity matched and of the relationships that reached it, as the answer holds them. */
export function linesOf(match: PatternMatch, answer: PatternRunOk, mask: boolean, personal: (entityType: string) => readonly string[]): readonly string[] {
  const node = answer.nodes.find((candidate) => elementKey(candidate.ref) === elementKey(match.match));
  return [...(node === undefined ? [] : linesOfProperties(node.display.title, node.properties, mask, personal(node.ref.entityType))), ...edgesOfMatch(match, answer).flatMap((edge) => linesOfProperties(edge.type, edge.properties, mask, []))];
}
