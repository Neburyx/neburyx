import type { Count } from '@neburyx/contracts';

/** A count as the page says it: the number alone when exact, "≥ n · lower bound" when it is a lower bound; nothing for any other quality. */
export function countText(count: Count): string | undefined {
  if (count.value === undefined) return undefined;
  if (count.quality === 'exact') return String(count.value);
  return count.quality === 'lowerBound' ? `≥ ${count.value} · lower bound` : undefined;
}

export function matchesText(count: Count): string | undefined {
  const text = countText(count);
  if (text === undefined) return undefined;
  return count.quality === 'exact' ? `${text} exact ${count.value === 1 ? 'match' : 'matches'}` : `≥ ${count.value} exact matches · lower bound`;
}

export function relatedText(count: Count): string | undefined {
  const text = countText(count);
  if (text === undefined) return undefined;
  return count.quality === 'exact' ? `${text} related ${count.value === 1 ? 'record' : 'records'}` : `≥ ${count.value} related records · lower bound`;
}

export function evidenceText(count: Count): string | undefined {
  const text = countText(count);
  if (text === undefined) return undefined;
  return count.quality === 'exact' ? `${text} supporting ${count.value === 1 ? 'relationship' : 'relationships'}` : `≥ ${count.value} supporting relationships · lower bound`;
}

export const secondsText = (elapsedMs: number): string => `${(elapsedMs / 1000).toFixed(2)} s`;
