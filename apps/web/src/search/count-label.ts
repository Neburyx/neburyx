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

/** The total of the entities a text matches as the Filters say it: "3 entities", "1 entity", "≥ 25 entities · lower bound"; nothing for a total that was not read. */
export function entitiesText(count: Count): string | undefined {
  if (count.value === undefined) return undefined;
  if (count.quality === 'exact') return `${count.value} ${count.value === 1 ? 'entity' : 'entities'}`;
  return count.quality === 'lowerBound' ? `≥ ${count.value} entities · lower bound` : undefined;
}

/**
 * What the total beside the Filters counts: the entities the text matches and, when the evidence records it finds are supporting relationships, how many, so a text that finds only evidence records does not read
 * as nothing found. The evidence part is left out when its count is zero or was not read.
 */
export function totalText(entities: Count, evidence: Count | undefined): string | undefined {
  const entitiesPart = entitiesText(entities);
  if (entitiesPart === undefined) return undefined;
  const evidencePart = evidence === undefined || evidence.value === undefined || evidence.value === 0 ? undefined : evidenceText(evidence);
  return evidencePart === undefined ? entitiesPart : `${entitiesPart} · ${evidencePart}`;
}

export const secondsText = (elapsedMs: number): string => `${(elapsedMs / 1000).toFixed(2)} s`;
