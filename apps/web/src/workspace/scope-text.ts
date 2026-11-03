import type { Count } from '@neburyx/contracts';
import type { LoadedGraph } from '../state/loaded-graph.js';

/** No loaded node carries a degree preview yet, so what is still out there is not known. */
export const UNKNOWN_REMAINDER: Count = { quality: 'unknown', scope: 'not yet retrieved' };

export function formatNumber(value: number): string {
  return value.toLocaleString('en-US');
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
