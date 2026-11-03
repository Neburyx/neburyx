import type { SourceSummary } from '@neburyx/contracts';

export type CurrentSource =
  | { readonly kind: 'bound'; readonly source: SourceSummary }
  | { readonly kind: 'bound-unknown'; readonly sourceId: string }
  | { readonly kind: 'only'; readonly source: SourceSummary }
  | { readonly kind: 'summary'; readonly total: number; readonly connected: number }
  | { readonly kind: 'none' };

/** The source bound to the investigation; else the only configured source; else a summary of them; else none. */
export function currentSource(items: readonly SourceSummary[], boundId: string | null): CurrentSource {
  if (boundId !== null) {
    const source = items.find((item) => item.id === boundId);
    return source === undefined ? { kind: 'bound-unknown', sourceId: boundId } : { kind: 'bound', source };
  }
  const [first, second] = items;
  if (first === undefined) return { kind: 'none' };
  if (second === undefined) return { kind: 'only', source: first };
  return { kind: 'summary', total: items.length, connected: items.filter((item) => item.state === 'connected').length };
}

/** The badge says the data is synthetic, so it is shown only when no real source could be in view. */
export function showsSyntheticBadge(current: CurrentSource, items: readonly SourceSummary[]): boolean {
  switch (current.kind) {
    case 'bound':
    case 'only':
      return current.source.synthetic;
    case 'summary':
      return items.every((item) => item.synthetic);
    case 'bound-unknown':
    case 'none':
      return false;
    default: {
      const unreachable: never = current;
      return unreachable;
    }
  }
}
