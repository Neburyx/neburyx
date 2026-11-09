import type { GraphEdge, GraphNode, SourceProfile } from '@neburyx/contracts';
import { observedProperty } from '../evidence/stored-evidence.js';
import { propertyText } from '../inspector/property-text.js';
import { edgeKey, elementKey } from '../state/keys.js';
import { partitionEdges, type LoadedGraph } from '../state/loaded-graph.js';
import { degreeCountText } from '../workspace/degree-text.js';
import { propertyCell, type Cell, type CompareElement, type Extra } from './compare-model.js';
import { MEMBERS, NOT_STATED, OBSERVED, RULE } from './copy.js';

/** What a column says about its element above the cells. */
export interface ColumnHeader {
  readonly key: string;
  readonly title: string;
  readonly caption: string;
  readonly reference: string | undefined;
}

export interface Resolved {
  readonly header: ColumnHeader;
  readonly element: CompareElement;
}

const NOT_STATED_CELL: Cell = { kind: 'not-stated', text: NOT_STATED };

const timeText = (value: string): string => propertyText(observedProperty(value));

/** The time of a stored or derived relationship, or an aggregate's first and last observed as one range; not stated when it holds no time at all. */
function observedCell(edge: GraphEdge): Cell {
  if ('aggregate' in edge.ref) {
    const { observedFirst: first, observedLast: last } = edge;
    if (first === undefined && last === undefined) return NOT_STATED_CELL;
    const text = first !== undefined && last !== undefined ? `${timeText(first)} to ${timeText(last)}` : first !== undefined ? `from ${timeText(first)}` : `until ${timeText(last ?? '')}`;
    return { kind: 'value', text, same: `r|${first ?? ''}|${last ?? ''}`, family: 'range' };
  }
  return edge.observedAt === undefined ? NOT_STATED_CELL : propertyCell(observedProperty(edge.observedAt));
}

function entityElement(node: GraphNode, profile: SourceProfile | undefined): Resolved {
  const type = profile?.entityTypes.find((entry) => entry.type === node.ref.entityType);
  return {
    header: { key: elementKey(node.ref), title: node.display.title, caption: type?.displayName ?? node.display.type, reference: node.ref.stableId },
    element: { key: elementKey(node.ref), kind: 'entity', mapped: type?.properties, properties: node.properties, extras: [] },
  };
}

function relationshipElement(edge: GraphEdge, graph: LoadedGraph, profile: SourceProfile | undefined): Resolved {
  const key = edgeKey(edge.ref);
  const derived = edge.semantics === 'derived' && edge.derivation !== undefined;
  const aggregate = 'aggregate' in edge.ref;
  const titleOf = (ref: GraphEdge['from']): string => graph.nodes.find((node) => elementKey(node.ref) === elementKey(ref))?.display.title ?? ref.stableId;
  const origin = derived ? `rule-derived · ${edge.derivation?.ruleId ?? ''} v${edge.derivation?.ruleVersion ?? 0}` : aggregate ? 'aggregate' : edge.semantics === 'unknown' ? 'origin not stated' : 'stored';
  const extras: Extra[] = [{ id: 'observed', label: OBSERVED, cell: observedCell(edge) }];
  if (aggregate && edge.memberCount !== undefined) extras.push({ id: 'members', label: MEMBERS, cell: { kind: 'value', text: degreeCountText(edge.memberCount), same: `m|${edge.memberCount.value ?? ''}|${edge.memberCount.quality}` } });
  if (derived && edge.derivation !== undefined) {
    const rule = `${edge.derivation.ruleId} v${edge.derivation.ruleVersion}`;
    extras.push({ id: 'rule', label: RULE, cell: { kind: 'value', text: rule, same: `r|${rule}` } });
  }
  const type = derived ? undefined : profile?.relationshipTypes.find((entry) => entry.type === edge.type && entry.from === edge.from.entityType && entry.to === edge.to.entityType);
  // the ID is in the header and the time is the Observed row, so neither is a property row
  const mapped = type?.properties.filter((name) => name !== type.stableIdProperty && name !== type.observedAt);
  return {
    header: { key, title: edge.type, caption: `${titleOf(edge.from)} → ${titleOf(edge.to)} · ${origin}`, reference: 'stableId' in edge.ref ? edge.ref.stableId : undefined },
    element: { key, kind: derived ? 'derived' : aggregate ? 'aggregate' : edge.semantics === 'unknown' ? 'unknown' : 'stored', mapped, properties: edge.properties, extras },
  };
}

/** The drawn elements the keys name, in the order of the keys; a key that is not drawn (hidden, filtered out, collapsed away, not loaded) is left out. */
export function resolveElements(graph: LoadedGraph, profile: SourceProfile | undefined, keys: readonly string[]): readonly Resolved[] {
  const nodes = new Map(graph.nodes.map((node) => [elementKey(node.ref), node]));
  const edges = new Map(partitionEdges(graph).drawable.map((edge) => [edgeKey(edge.ref), edge]));
  const resolved: Resolved[] = [];
  for (const key of keys) {
    const node = nodes.get(key);
    const edge = edges.get(key);
    if (node !== undefined) resolved.push(entityElement(node, profile));
    else if (edge !== undefined) resolved.push(relationshipElement(edge, graph, profile));
  }
  return resolved;
}

/** Whether the title already holds the reference as a whole word, so that a line under it would repeat it ("Account 110057" holds "110057", "Title n10" does not hold "n1"). */
export function titleHoldsReference(title: string, reference: string): boolean {
  return new RegExp(`(^|[\\s·,(])${reference.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[\\s·,)])`).test(title);
}

/** The title and caption of an element for a note that names it. */
export function headerOf(graph: LoadedGraph, profile: SourceProfile | undefined, key: string): ColumnHeader | undefined {
  return resolveElements(graph, profile, [key])[0]?.header;
}
