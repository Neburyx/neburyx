export type DegreeDirection = 'out' | 'in';

export interface DegreePair {
  readonly relationshipType: string;
  readonly direction: DegreeDirection;
}

export interface DegreeRow {
  readonly type: string;
  readonly from: string;
  readonly to: string;
}

/**
 * The (relationship type, direction) pairs a node of the entity type has in the mapping, each once, in the order of the mapping rows: a row leaves the node when the type is its `from`
 * and enters it when the type is its `to`, so a row between a type and itself gives both directions. The gate counts one value for each pair, in this order.
 */
export function degreePairsOf(rows: readonly DegreeRow[], entityType: string): readonly DegreePair[] {
  const seen = new Set<string>();
  const pairs: DegreePair[] = [];
  for (const row of rows) {
    for (const [matches, direction] of [[row.from === entityType, 'out'], [row.to === entityType, 'in']] as const) {
      const key = JSON.stringify([row.type, direction]);
      if (!matches || seen.has(key)) continue;
      seen.add(key);
      pairs.push({ relationshipType: row.type, direction });
    }
  }
  return pairs;
}
