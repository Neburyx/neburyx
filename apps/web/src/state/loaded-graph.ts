import type { Count, GraphEdge, GraphNode } from '@neburyx/contracts';
import type { InvestigationState } from './investigation-state.js';
import { edgeKey, elementKey, queryKeyText } from './keys.js';
import type { ServerState } from './server-state.js';

export interface LoadedGraph {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly entities: Count;
  readonly relationships: Count;
}

const LOADED_SCOPE = 'loaded in this view';

function exact(value: number): Count {
  return { value, quality: 'exact', scope: LOADED_SCOPE };
}

const derived = new WeakMap<ServerState, WeakMap<InvestigationState, LoadedGraph>>();

/** The records of the results the investigation names that its refs name, once each; the counts are of these, and exact because they are what the client holds. A result cached for another principal, policy or filter is never read. The same two states give the same graph object, so every part of the page that asks shares one derivation. */
export function deriveLoadedGraph(server: ServerState, investigation: InvestigationState): LoadedGraph {
  let byInvestigation = derived.get(server);
  if (byInvestigation === undefined) {
    byInvestigation = new WeakMap();
    derived.set(server, byInvestigation);
  }
  const known = byInvestigation.get(investigation);
  if (known !== undefined) return known;
  const graph = deriveFresh(server, investigation);
  byInvestigation.set(investigation, graph);
  return graph;
}

function deriveFresh(server: ServerState, investigation: InvestigationState): LoadedGraph {
  const wantedNodes = new Set(investigation.nodeRefs.map(elementKey));
  const wantedEdges = new Set(investigation.edgeRefs.map(edgeKey));
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  for (const key of investigation.resultKeys) {
    const result = server.results.get(queryKeyText(key));
    if (result === undefined || result.sourceId !== investigation.sourceId) continue;
    for (const node of result.nodes) {
      const id = elementKey(node.ref);
      if (wantedNodes.has(id)) nodes.set(id, node);
    }
    for (const edge of result.edges) {
      const id = edgeKey(edge.ref);
      if (wantedEdges.has(id)) edges.set(id, edge);
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()], entities: exact(nodes.size), relationships: exact(edges.size) };
}

export interface EdgePartition {
  readonly drawable: readonly GraphEdge[];
  readonly notDrawable: readonly GraphEdge[];
}

/** A relationship can be drawn only between two loaded entities; the others are loaded but not drawable. */
export function partitionEdges(graph: LoadedGraph): EdgePartition {
  const loaded = new Set(graph.nodes.map((node) => elementKey(node.ref)));
  const drawable: GraphEdge[] = [];
  const notDrawable: GraphEdge[] = [];
  for (const edge of graph.edges) (loaded.has(elementKey(edge.from)) && loaded.has(elementKey(edge.to)) ? drawable : notDrawable).push(edge);
  return { drawable, notDrawable };
}

/** The entity focus is on and its neighbors: the loaded entities joined to it by a loaded relationship in either direction. Empty when `focus` is not a loaded entity. */
export function neighborhoodOf(graph: LoadedGraph, focus: string): ReadonlySet<string> {
  const loaded = new Set(graph.nodes.map((node) => elementKey(node.ref)));
  if (!loaded.has(focus)) return new Set();
  const near = new Set([focus]);
  for (const edge of graph.edges) {
    const from = elementKey(edge.from);
    const to = elementKey(edge.to);
    if (from === focus && loaded.has(to)) near.add(to);
    else if (to === focus && loaded.has(from)) near.add(from);
  }
  return near;
}

/** The loaded entities outside the focused entity's neighborhood that are not hidden by hand; none when focus is off or not loaded. */
export function outsideFocusKeys(graph: LoadedGraph, focus: string | undefined, hidden: ReadonlySet<string>): ReadonlySet<string> {
  if (focus === undefined) return new Set();
  const near = neighborhoodOf(graph, focus);
  if (near.size === 0) return new Set();
  return new Set(graph.nodes.map((node) => elementKey(node.ref)).filter((key) => !near.has(key) && !hidden.has(key)));
}

export interface Exclusion {
  readonly hidden: ReadonlySet<string>;
  readonly neighborhoodFocus: string | undefined;
  readonly filtered?: ReadonlySet<string> | undefined;
}

interface ExcludedEntry extends Exclusion {
  readonly result: ReadonlySet<string>;
}

const excluded = new WeakMap<LoadedGraph, ExcludedEntry>();

/** Every entity key the canvas leaves out: hidden by hand, hidden by a filter, or outside the neighborhood focus is on. The same inputs give the same set object, so what is derived from it is shared. */
export function excludedKeys(graph: LoadedGraph, exclusion: Exclusion): ReadonlySet<string> {
  const { hidden, neighborhoodFocus, filtered } = exclusion;
  const near = neighborhoodFocus === undefined ? undefined : neighborhoodOf(graph, neighborhoodFocus);
  const focusing = near !== undefined && near.size > 0;
  if (!focusing && (filtered === undefined || filtered.size === 0)) return hidden;
  const known = excluded.get(graph);
  if (known !== undefined && known.hidden === hidden && known.neighborhoodFocus === neighborhoodFocus && known.filtered === filtered) return known.result;
  const result = new Set(hidden);
  for (const key of filtered ?? []) result.add(key);
  if (focusing) for (const node of graph.nodes) if (!near.has(elementKey(node.ref))) result.add(elementKey(node.ref));
  excluded.set(graph, { hidden, neighborhoodFocus, filtered, result });
  return result;
}

const visibleGraphs = new WeakMap<LoadedGraph, WeakMap<ReadonlySet<string>, LoadedGraph>>();

/** What is drawn of the loaded graph: the entities that are not excluded (see `excludedKeys`) and the relationships that touch none of the excluded. The counts stay those of the loaded graph, because hiding removes nothing from the investigation. The same two inputs give the same object. */
export function visibleGraph(graph: LoadedGraph, left: ReadonlySet<string>): LoadedGraph {
  if (left.size === 0) return graph;
  let byHidden = visibleGraphs.get(graph);
  if (byHidden === undefined) {
    byHidden = new WeakMap();
    visibleGraphs.set(graph, byHidden);
  }
  const known = byHidden.get(left);
  if (known !== undefined) return known;
  const visible: LoadedGraph = {
    ...graph,
    nodes: graph.nodes.filter((node) => !left.has(elementKey(node.ref))),
    edges: graph.edges.filter((edge) => !left.has(elementKey(edge.from)) && !left.has(elementKey(edge.to))),
  };
  byHidden.set(left, visible);
  return visible;
}

/** The keys of every element the canvas draws: each loaded entity and each relationship between two loaded entities. */
export function drawnKeys(graph: LoadedGraph): ReadonlySet<string> {
  return new Set([...graph.nodes.map((node) => elementKey(node.ref)), ...partitionEdges(graph).drawable.map((edge) => edgeKey(edge.ref))]);
}
