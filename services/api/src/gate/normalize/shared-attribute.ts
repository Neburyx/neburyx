import type { ElementRef } from '@neburyx/contracts';
import { normalizeRows, type Normalized, type NormalizeContext } from './index.js';
import { isPlainNode, normalizeNode, type PlainNode } from './node.js';

/** A shared-attribute run, normalized: the nodes and edges of every row, the other entities that matched, and the flags the read raised. */
export interface NormalizedShared extends Normalized {
  readonly matches: readonly ElementRef[];
  /** The read found the anchor: it answered at least one row, even one with no match. */
  readonly anchorFound: boolean;
  /** The anchor holds an attribute node on the stop list, which the read skipped. */
  readonly skipped: boolean;
  /** A bound of the read (the anchor's attribute nodes or the pairs read) was hit, so there may be more matches. */
  readonly bounded: boolean;
  /** A match shares more attribute nodes than the evidence shows. */
  readonly evidenceCut: boolean;
}

export function isNormalizedShared(item: unknown): item is NormalizedShared {
  if (typeof item !== 'object' || item === null) return false;
  return 'nodes' in item && Array.isArray(item.nodes) && 'edges' in item && Array.isArray(item.edges) && 'warnings' in item && Array.isArray(item.warnings) && 'matches' in item && Array.isArray(item.matches) && 'anchorFound' in item && 'bounded' in item;
}

const nodesIn = (value: unknown): readonly PlainNode[] => (Array.isArray(value) ? value : [value]).filter(isPlainNode);

/**
 * The nodes and edges of the rows of a shared-attribute read, each node read as the entity type the request named for it (the anchor and the matches as the anchor's type, the shared nodes as the attribute's type), and the
 * matches among them. An aggregate edge of a type with no stable ID shows one member of the relationship, so its member count is always a lower bound.
 */
export function normalizeSharedAttribute(context: NormalizeContext, rows: readonly Readonly<Record<string, unknown>>[]): NormalizedShared {
  const [anchorType, attributeType] = [context.params?.['entityType'], context.params?.['attributeType']];
  if (typeof anchorType !== 'string' || typeof attributeType !== 'string') return { ...normalizeRows(context, []), matches: [], anchorFound: false, skipped: false, bounded: false, evidenceCut: false };
  const shown = { ...context, hasMore: true };
  const expected = new Map<string, readonly string[]>();
  const expect = (plain: PlainNode, type: string): void => void expected.set(plain.elementId, [...new Set([...(expected.get(plain.elementId) ?? []), type])]);
  for (const row of rows) {
    for (const plain of nodesIn(row['a'])) expect(plain, anchorType);
    for (const plain of nodesIn(row['b'])) expect(plain, anchorType);
    for (const plain of nodesIn(row['xs'])) expect(plain, attributeType);
  }
  const normalized = normalizeRows(shown, rows, expected);
  const matches: ElementRef[] = [];
  for (const row of rows) {
    for (const plain of nodesIn(row['b'])) {
      const result = normalizeNode(shown, plain, anchorType);
      if ('node' in result && !matches.some((known) => known.entityType === result.node.ref.entityType && known.stableId === result.node.ref.stableId)) matches.push(result.node.ref);
    }
  }
  return {
    ...normalized,
    matches,
    anchorFound: rows.length > 0,
    skipped: rows.some((row) => row['skipped'] === true),
    bounded: rows.some((row) => row['bounded'] === true),
    evidenceCut: rows.some((row) => row['evidenceCut'] === true),
  };
}
