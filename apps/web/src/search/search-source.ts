import type { SourceSummary } from '@neburyx/contracts';

export type SearchSource =
  | { readonly kind: 'none' }
  | { readonly kind: 'unknown'; readonly sourceId: string }
  | { readonly kind: 'chosen'; readonly source: SourceSummary; readonly completesUrl: boolean };

const inOrder = (first: string, second: string): number => (first < second ? -1 : first > second ? 1 : 0);

/**
 * The source a search reads: the one the link names; without one, the source of the investigation opened last in this session when it is configured, else the first
 * configured source by name. A link naming a source that is not configured is not searched.
 */
export function chooseSearchSource(items: readonly SourceSummary[], requested: string | null, lastOpenedId: string | null): SearchSource {
  if (requested !== null) {
    const named = items.find((item) => item.id === requested);
    return named === undefined ? { kind: 'unknown', sourceId: requested } : { kind: 'chosen', source: named, completesUrl: false };
  }
  const [first] = [...items].sort((left, right) => inOrder(left.alias, right.alias) || inOrder(left.id, right.id));
  const last = items.find((item) => item.id === lastOpenedId);
  const chosen = last ?? first;
  return chosen === undefined ? { kind: 'none' } : { kind: 'chosen', source: chosen, completesUrl: true };
}
