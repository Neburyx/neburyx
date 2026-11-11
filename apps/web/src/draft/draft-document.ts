import type { DraftWriteRequest, EdgeRef, ElementRef, GraphEdge, LayoutDocument, QueryContextDocument } from '@neburyx/contracts';
import { elementKey, edgeKey } from '../state/keys.js';
import type { LoadedGraph } from '../state/loaded-graph.js';
import type { MappedTypes, PresentationState } from '../state/presentation-state.js';

type LayoutNode = LayoutDocument['nodes'][number];
type StoredEdge = QueryContextDocument['loaded']['edges'][number];

/** Items a stored draft names that the source could not give back: they stay in the draft, so that one read that finds less never shortens it. */
export interface KeptItems {
  readonly nodes: readonly LayoutNode[];
  readonly edges: readonly StoredEdge[];
}

export const NOTHING_KEPT: KeptItems = { nodes: [], edges: [] };

const SCHEMA_VERSION = 1;
const NODE_SEPARATOR = '\u0000';

const nodeIdentity = (type: string, id: string): string => `${type}${NODE_SEPARATOR}${id}`;
const edgeIdentity = (edge: StoredEdge): string => JSON.stringify([edge.t, edge.from.t, edge.from.id, edge.to.t, edge.to.id, edge.id ?? null, edge.ruleId ?? null]);

function storedEdgeOf(edge: GraphEdge): StoredEdge {
  const ends = { from: { t: edge.from.entityType, id: edge.from.stableId }, to: { t: edge.to.entityType, id: edge.to.stableId } };
  const { ref } = edge;
  if ('stableId' in ref) return { t: ref.type, ...ends, id: ref.stableId };
  if ('derived' in ref) return { t: edge.type, ...ends, ruleId: ref.derived.ruleId };
  return { t: ref.aggregate.type, ...ends };
}

/** The types of a kind that are left switched on when at least one is switched off; none when no type is off or the mapping is not known. */
function typesLeftOn(known: readonly string[] | undefined, off: ReadonlySet<string>, keepList = false): string[] {
  return known === undefined || (off.size === 0 && !keepList) ? [] : known.filter((type) => !off.has(type));
}

const withCarried = (left: string[], carried: readonly string[] = [], keepList = false): string[] => (left.length === 0 && !keepList ? left : [...left, ...carried.filter((type) => !left.includes(type))]);

/**
 * The parts of a stored draft that the web does not edit: a write carries them through as they were read. Expansions are carried even when the node they start from is no longer in the draft. Groups are carried with the members still in the draft,
 * and a group with none left is dropped with the group marks of its nodes.
 */
export interface CarriedContext {
  readonly expansions: QueryContextDocument['expansions'];
  readonly time: QueryContextDocument['filters']['time'];
  readonly properties: QueryContextDocument['filters']['properties'];
  readonly groups: LayoutDocument['groups'];
  /** The group of each node that has one, by the identity of the node. */
  readonly groupIds: ReadonlyMap<string, string>;
  /** The stored relationships that were hidden, by identity. */
  readonly hiddenEdges: ReadonlySet<string>;
  /** A layout name the web does not offer, and the layout shown when it was adopted: written back until the person picks another layout. */
  readonly layout?: { readonly stored: string; readonly shown: string } | undefined;
}

/** What the web does not edit in a stored draft; `shown` is the layout the view has once the draft is applied, and `layoutKnown` whether the web offers the stored layout name. */
export function carriedOf(draft: { readonly layout: LayoutDocument; readonly queryContext: QueryContextDocument }, shown: string, layoutKnown: boolean): CarriedContext {
  const { layout, queryContext } = draft;
  return {
    expansions: queryContext.expansions,
    time: queryContext.filters.time,
    properties: queryContext.filters.properties,
    groups: layout.groups,
    groupIds: new Map(layout.nodes.flatMap((node) => (node.groupId === null ? [] : [[nodeIdentity(node.t, node.id), node.groupId] as const]))),
    hiddenEdges: new Set(layout.edges.filter((edge) => edge.hidden).map(edgeIdentity)),
    ...(layoutKnown ? {} : { layout: { stored: layout.layout, shown } }),
  };
}

export interface DraftInputs {
  readonly nodeRefs: readonly ElementRef[];
  readonly graph: LoadedGraph;
  readonly presentation: Pick<PresentationState, 'layout' | 'positions' | 'pins' | 'hidden' | 'viewport' | 'typeFilter' | 'mappedTypes'>;
  readonly notes: string | null;
  readonly kept: KeptItems;
  /** What the stored draft holds that the web has no way to edit (see `CarriedContext`), written back as it was read. */
  readonly carried?: CarriedContext | undefined;
  /** The filters of the stored draft, written unchanged until the mapping of the source is known and they can be put back on the view. */
  readonly storedFilters?: QueryContextDocument['filters'] | undefined;
  /** Types the stored filters name that the mapping does not have now: written back with the types left on, so that a type that is mapped again has the state it was saved with. */
  readonly carriedTypes?: { readonly entityTypes: readonly string[]; readonly relTypes: readonly string[] } | undefined;
  /** The stored list of a kind was not empty, so some type was off when it was saved, and the person has not changed that kind since: the list is written as a list even when no mapped type is off now, since a type the mapping dropped may have been the one that was off. */
  readonly keepLists?: { readonly entityTypes: boolean; readonly relTypes: boolean } | undefined;
}

/** The draft as it is written: references only, never a property value. The layout direction, physics, selection and panels are not part of it. */
export function draftOf(inputs: DraftInputs): DraftWriteRequest {
  const { presentation } = inputs;
  const held = new Set<string>();
  const nodes: LayoutNode[] = inputs.nodeRefs.map((ref) => {
    held.add(nodeIdentity(ref.entityType, ref.stableId));
    const key = elementKey(ref);
    const position = presentation.positions.get(key);
    return { t: ref.entityType, id: ref.stableId, ...(position === undefined ? {} : { x: position.x, y: position.y }), pinned: presentation.pins.has(key), hidden: presentation.hidden.has(key), groupId: inputs.carried?.groupIds.get(nodeIdentity(ref.entityType, ref.stableId)) ?? null };
  });
  const edges: StoredEdge[] = inputs.graph.edges.map(storedEdgeOf);
  const heldEdges = new Set(edges.map(edgeIdentity));
  const keptNodes = inputs.kept.nodes.filter((node) => !held.has(nodeIdentity(node.t, node.id)));
  const keptEdges = inputs.kept.edges.filter((edge) => !heldEdges.has(edgeIdentity(edge)));
  const present = new Set([...nodes, ...keptNodes].map((node) => nodeIdentity(node.t, node.id)));
  const groups = (inputs.carried?.groups ?? []).map((group) => ({ ...group, members: group.members.filter((member) => present.has(nodeIdentity(member.t, member.id))) })).filter((group) => group.members.length > 0);
  const live = new Set(groups.map((group) => group.id));
  const allNodes = [...nodes, ...keptNodes].map((node) => (node.groupId === null || live.has(node.groupId) ? node : { ...node, groupId: null }));
  const allEdges = [...edges, ...keptEdges];
  const mapped: Partial<MappedTypes> = presentation.mappedTypes ?? {};
  const layout: LayoutDocument = {
    schemaVersion: SCHEMA_VERSION,
    ...(presentation.viewport === undefined ? {} : { viewport: { zoom: presentation.viewport.zoom, x: presentation.viewport.x, y: presentation.viewport.y } }),
    layout: inputs.carried?.layout !== undefined && presentation.layout === inputs.carried.layout.shown ? inputs.carried.layout.stored : presentation.layout,
    nodes: allNodes,
    edges: allEdges.map((edge) => ({ ...edge, hidden: inputs.carried?.hiddenEdges.has(edgeIdentity(edge)) ?? false })),
    groups,
  };
  const queryContext: QueryContextDocument = {
    schemaVersion: SCHEMA_VERSION,
    loaded: { nodes: allNodes.map(({ t, id }) => ({ t, id })), edges: allEdges },
    expansions: inputs.carried?.expansions ?? [],
    filters: inputs.storedFilters ?? { entityTypes: withCarried(typesLeftOn(mapped.entityTypes, presentation.typeFilter.offEntityTypes, inputs.keepLists?.entityTypes), inputs.carriedTypes?.entityTypes, inputs.keepLists?.entityTypes), relTypes: withCarried(typesLeftOn(mapped.relationshipTypes, presentation.typeFilter.offRelationshipTypes, inputs.keepLists?.relTypes), inputs.carriedTypes?.relTypes, inputs.keepLists?.relTypes), time: inputs.carried?.time ?? null, properties: inputs.carried?.properties ?? [] },
  };
  return { layout, queryContext, notes: inputs.notes };
}

/** The references a stored query context asks the source for, in the lists `POST /v1/graph/read-refs` takes. */
export function refsOf(sourceId: string, queryContext: QueryContextDocument) {
  const entities: ElementRef[] = queryContext.loaded.nodes.map((node) => ({ sourceId, entityType: node.t, stableId: node.id }));
  const edges: Extract<EdgeRef, { stableId: string }>[] = [];
  const aggregates: Extract<EdgeRef, { aggregate: unknown }>[] = [];
  const derived: Extract<EdgeRef, { derived: unknown }>[] = [];
  for (const edge of queryContext.loaded.edges) {
    const from: ElementRef = { sourceId, entityType: edge.from.t, stableId: edge.from.id };
    const to: ElementRef = { sourceId, entityType: edge.to.t, stableId: edge.to.id };
    if (edge.id !== undefined) edges.push({ sourceId, type: edge.t, from: edge.from.t, to: edge.to.t, stableId: edge.id });
    else if (edge.ruleId !== undefined) derived.push({ sourceId, derived: { ruleId: edge.ruleId, from, to } });
    else aggregates.push({ sourceId, aggregate: { type: edge.t, from, to } });
  }
  return { entities, edges, aggregates, derived };
}

/** The entries of a stored draft that a read did not give back, ready to be kept. */
export function keptFrom(sourceId: string, layout: LayoutDocument, queryContext: QueryContextDocument, missing: { readonly entities: readonly ElementRef[]; readonly edges: readonly EdgeRef[] }): KeptItems {
  const gone = new Set(missing.entities.map((ref) => nodeIdentity(ref.entityType, ref.stableId)));
  const goneEdges = new Set(missing.edges.map((ref) => edgeKey(ref)));
  const wanted = (edge: StoredEdge): boolean => {
    const asked = refsOf(sourceId, { ...queryContext, loaded: { nodes: [], edges: [edge] } });
    const ref = asked.edges[0] ?? asked.derived[0] ?? asked.aggregates[0];
    return ref !== undefined && goneEdges.has(edgeKey(ref));
  };
  return { nodes: layout.nodes.filter((node) => gone.has(nodeIdentity(node.t, node.id))), edges: queryContext.loaded.edges.filter(wanted) };
}
