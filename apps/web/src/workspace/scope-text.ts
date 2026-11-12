import { notRetrievedText, type Count } from '@neburyx/contracts';
import type { NotRetrieved } from '../api/coverage-store.js';
import { elementKey } from '../state/keys.js';
import { partitionEdges, type LoadedGraph } from '../state/loaded-graph.js';

/** No loaded node carries a degree preview yet, so what is still out there is not known. */
export const UNKNOWN_REMAINDER: NotRetrieved = { count: { quality: 'unknown', scope: 'not yet retrieved' }, uncounted: 0 };

const NUMBER_FORMAT = new Intl.NumberFormat('en-US');

export function formatNumber(value: number): string {
  return NUMBER_FORMAT.format(value);
}

function qualityWord(quality: Count['quality']): string {
  switch (quality) {
    case 'exact':
      return 'exact';
    case 'estimated':
      return 'estimated';
    case 'lowerBound':
      return 'lower bound';
    case 'unknown':
      return 'unknown';
    default: {
      const unreachable: never = quality;
      return unreachable;
    }
  }
}

function numberText(count: Count): string | undefined {
  if (count.value === undefined) return undefined;
  switch (count.quality) {
    case 'exact':
      return formatNumber(count.value);
    case 'estimated':
      return `~${formatNumber(count.value)}`;
    case 'lowerBound':
      return `≥ ${formatNumber(count.value)}`;
    case 'unknown':
      return undefined;
    default: {
      const unreachable: never = count.quality;
      return unreachable;
    }
  }
}

function counted(count: Count, one: string, many: string): string {
  const text = numberText(count);
  return text === undefined ? many : `${text} ${count.value === 1 ? one : many}`;
}

const STRENGTH: readonly Count['quality'][] = ['exact', 'estimated', 'lowerBound', 'unknown'];

function weakest(a: Count['quality'], b: Count['quality']): Count['quality'] {
  return STRENGTH.indexOf(a) >= STRENGTH.indexOf(b) ? a : b;
}

export function loadedLine(graph: LoadedGraph): string {
  const quality = qualityWord(weakest(graph.entities.quality, graph.relationships.quality));
  return `${counted(graph.entities, 'entity', 'entities')} · ${counted(graph.relationships, 'relationship', 'relationships')} · loaded · ${quality}`;
}

/** The counts of an investigation drawn from its saved layout while its source cannot be read: the items are the saved ones and nothing was loaded from the source. */
export function savedLayoutLine(graph: LoadedGraph): string {
  return `${counted(graph.entities, 'entity', 'entities')} · ${counted(graph.relationships, 'relationship', 'relationships')} · saved layout, not read`;
}

/** What is left to show of the saved items; nothing more can be retrieved, so no remainder is named. */
export function savedLayoutShownLine(shown: number): string {
  return `${formatNumber(shown)} shown`;
}

export function remainderLine(shown: number, remainder: NotRetrieved): string {
  return `${formatNumber(shown)} shown · ${notRetrievedText(remainder.count, remainder.uncounted)}`;
}

/** The relationships that are loaded but cannot be drawn, as an exact count the client holds; nothing when there are none. */
export function notDrawnLine(count: number): string | undefined {
  if (count === 0) return undefined;
  return `${formatNumber(count)} ${count === 1 ? 'relationship' : 'relationships'} not drawn (entity not loaded)`;
}

/** The loaded entities the person has hidden from the view; nothing when none are. */
export function hiddenFromViewLine(hidden: number): string | undefined {
  return hidden === 0 ? undefined : `${formatNumber(hidden)} hidden from view`;
}

/** The loaded entities outside the neighborhood focus is on, not counting those hidden by hand; shown whenever focus is on, even at 0, so the way out stays. */
export function outsideFocusLine(outside: number): string {
  return `${formatNumber(outside)} outside focus`;
}

/** The entities loaded that a filter hides; nothing when none are hidden. */
export function hiddenByFiltersLine(filtered: number): string | undefined {
  return filtered === 0 ? undefined : `${formatNumber(filtered)} hidden by filters`;
}

/** The entities a filter hides that are not already out of the view by hand or outside the neighborhood focus; the three parts never overlap. */
export function filteredOnlyCount(loaded: readonly string[], hidden: ReadonlySet<string>, filtered: ReadonlySet<string>, outside: ReadonlySet<string> = new Set()): number {
  return loaded.filter((key) => filtered.has(key) && !hidden.has(key) && !outside.has(key)).length;
}

/** The result line of the Filters panel: "M of L match · exact · H hidden", where L is the loaded entities not hidden by hand or outside the neighborhood focus (as the caller passes them in `hidden`), M those of them a filter leaves, and H the rest; nothing when nothing is loaded. */
export function filterResultLine(loaded: readonly string[], hidden: ReadonlySet<string>, filtered: ReadonlySet<string>): string | undefined {
  if (loaded.length === 0) return undefined;
  const counted = loaded.filter((key) => !hidden.has(key));
  const hiding = filteredOnlyCount(loaded, hidden, filtered);
  return `${formatNumber(counted.length - hiding)} of ${formatNumber(counted.length)} match · exact · ${formatNumber(hiding)} hidden`;
}

/** The relationships line of the Filters panel while a relationship type is off: "M of L relationships match", where L is the relationships with both ends loaded that touch no entity hidden by hand and M those of them that are drawn (their type is on and neither end is filtered). Nothing while no relationship type is off. */
export function relationshipResultLine(graph: LoadedGraph, hidden: ReadonlySet<string>, filtered: ReadonlySet<string>, offTypes: ReadonlySet<string>): string | undefined {
  if (offTypes.size === 0) return undefined;
  const { drawable } = partitionEdges(graph);
  const counted = drawable.filter((edge) => !hidden.has(elementKey(edge.from)) && !hidden.has(elementKey(edge.to)));
  const matching = counted.filter((edge) => !offTypes.has(edge.type) && !filtered.has(elementKey(edge.from)) && !filtered.has(elementKey(edge.to)));
  return `${formatNumber(matching.length)} of ${formatNumber(counted.length)} ${counted.length === 1 ? 'relationship matches' : 'relationships match'}`;
}

/** What is left to show of the loaded entities: those neither hidden by hand, nor by a filter, nor outside the neighborhood focus is on; an entity that is both counts once, and a key that is not loaded counts for nothing. */
export function shownCount(loaded: readonly string[], hidden: ReadonlySet<string>, filtered: ReadonlySet<string>, outside: ReadonlySet<string> = new Set()): number {
  return loaded.filter((key) => !hidden.has(key) && !filtered.has(key) && !outside.has(key)).length;
}
