import type { Count } from '@neburyx/contracts';
import type { LoadedGraph } from '../state/loaded-graph.js';

/** No loaded node carries a degree preview yet, so what is still out there is not known. */
export const UNKNOWN_REMAINDER: Count = { quality: 'unknown', scope: 'not yet retrieved' };

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

export function remainderLine(shown: number, remainder: Count): string {
  const number = numberText(remainder);
  if (number === undefined) return `${formatNumber(shown)} shown · more not yet retrieved`;
  return `${formatNumber(shown)} shown · ${number} not yet retrieved (${qualityWord(remainder.quality)})`;
}

/** The relationships that are loaded but cannot be drawn, as an exact count the client holds; nothing when there are none. */
export function notDrawnLine(count: number): string | undefined {
  if (count === 0) return undefined;
  return `${formatNumber(count)} ${count === 1 ? 'relationship' : 'relationships'} not drawn (entity not loaded)`;
}

/** The entities loaded that a filter hides, never more than are loaded; nothing when none are hidden. */
export function hiddenByFiltersLine(filtered: number, loaded: number): string | undefined {
  const hidden = Math.min(filtered, loaded);
  return hidden === 0 ? undefined : `${formatNumber(hidden)} hidden by filters`;
}

export function shownCount(loaded: number, filtered: number): number {
  return Math.max(0, loaded - filtered);
}
