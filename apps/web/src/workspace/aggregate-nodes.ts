import type { Count, DegreePreview, ElementRef, IconKey, SourceProfile } from '@neburyx/contracts';
import type { NodeExpansion } from '../api/expand-store.js';
import { degreeCountText } from './degree-text.js';
import { formatNumber } from './scope-text.js';
import type { LoadedGraph } from '../state/loaded-graph.js';
import { elementKey } from '../state/keys.js';
import { loadedOf, notLoadedOf } from './node-counts.js';
import { allNeighborTypes } from './supernode-options.js';

/** What stands for the neighbors of one type that are not loaded: drawn beside their node, never a loaded entity. */
export interface AggregateNode {
  /** The key of the node the neighbors belong to. */
  readonly nodeKey: string;
  readonly neighborType: string;
  readonly iconKey: IconKey;
  /** "Account · 8 / 12", with the total's quality in front of its number when it is not exact; "Account · 8 loaded" when the total has no number. */
  readonly label: string;
  /** The caption's two lines: the type's name, then the figures ("8 / 12"), each short enough for the room a caption has. */
  readonly name: string;
  readonly figures: string;
  readonly detail: string;
  /** What a screen reader is told: the type, how many relationships are loaded of how many, and that not all are. */
  readonly spoken: string;
}

const AGGREGATE_PREFIX = 'remainder';

export const aggregateKey = (nodeKey: string, neighborType: string): string => JSON.stringify([AGGREGATE_PREFIX, nodeKey, neighborType]);
export const aggregateLinkKey = (nodeKey: string, neighborType: string): string => JSON.stringify([`${AGGREGATE_PREFIX}-link`, nodeKey, neighborType]);

/** The node and neighbor type an aggregate node's key names; undefined for any other key. */
export function parseAggregateKey(key: string): { readonly nodeKey: string; readonly neighborType: string } | undefined {
  try {
    const parts: unknown = JSON.parse(key);
    if (Array.isArray(parts) && parts.length === 3 && parts[0] === AGGREGATE_PREFIX && typeof parts[1] === 'string' && typeof parts[2] === 'string') return { nodeKey: parts[1], neighborType: parts[2] };
  } catch {
    // a key that is not JSON is not an aggregate key
  }
  return undefined;
}

const numberWithQuality = (count: Count): string => `${count.quality === 'estimated' ? '~ ' : count.quality === 'lowerBound' ? '≥ ' : ''}${formatNumber(count.value ?? 0)}`;

export interface AggregateInput {
  readonly graph: LoadedGraph;
  readonly profile: SourceProfile | undefined;
  /** The nodes the person opened in the panel or expanded in this investigation, by key. */
  readonly touched: ReadonlySet<string>;
  /** The degree preview held for a node under the current masking setting, without asking for one. */
  readonly previewOf: (ref: ElementRef) => DegreePreview | undefined;
  readonly expansionOf: (ref: ElementRef) => NodeExpansion;
  /** The relationship types the chain of a neighbor type was started with; none for all sourced types. */
  readonly relTypesOf: (ref: ElementRef, neighborType: string) => readonly string[] | undefined;
  readonly mapped: (entityType: string) => readonly string[];
}

/** One aggregate node for each neighbor type of each touched node that has a held preview and something not loaded: not for a type whose total is not known and nothing was read, and not for one whose pages over all sourced types have ended or whose remainder is exactly zero. */
export function aggregateNodesOf(input: AggregateInput): readonly AggregateNode[] {
  const out: AggregateNode[] = [];
  for (const node of input.graph.nodes) {
    const nodeKey = elementKey(node.ref);
    if (!input.touched.has(nodeKey)) continue;
    const preview = input.previewOf(node.ref);
    if (preview === undefined) continue;
    const loaded = loadedOf(input.graph, node.ref);
    const expansion = input.expansionOf(node.ref);
    for (const type of new Set([...input.mapped(node.ref.entityType), ...allNeighborTypes(preview, [])])) {
      const total = preview.byNeighborType.find((entry) => entry.entityType === type)?.count;
      const progress = expansion.types.get(type);
      const known = total?.value !== undefined;
      if (!known && progress === undefined) continue;
      const have = loaded.byType.get(type) ?? { value: 0, quality: 'exact' as const, scope: 'loaded in this view' };
      const chain = input.relTypesOf(node.ref, type);
      const ended = progress !== undefined && !progress.hasMore && !progress.restartNeeded && (chain === undefined || chain.length === 0);
      const remainder = notLoadedOf(total, have);
      if (ended || (remainder !== undefined && remainder.value === 0 && remainder.quality === 'exact')) continue;
      const entity = input.profile?.entityTypes.find((entry) => entry.type === type);
      const name = entity?.displayName ?? type;
      const label = known && total !== undefined ? `${name} · ${numberWithQuality(have)} / ${numberWithQuality(total)}` : `${name} · ${numberWithQuality(have)} loaded`;
      const spoken = known && total !== undefined ? `${name}: ${numberWithQuality(have)} of ${numberWithQuality(total)} relationships loaded, not all loaded` : `${name}: ${numberWithQuality(have)} relationships loaded, not all loaded`;
      out.push({ nodeKey, neighborType: type, iconKey: entity?.icon ?? 'generic', label, name, figures: known && total !== undefined ? `${numberWithQuality(have)} / ${numberWithQuality(total)}` : `${numberWithQuality(have)} loaded`, detail: known && total !== undefined ? `total ${degreeCountText(total)}` : 'total: no count', spoken });
    }
  }
  return out;
}
