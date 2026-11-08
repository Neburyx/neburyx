import type { GraphEdge } from '@neburyx/contracts';
import { MEMBERS_PER_NEIGHBOR, type ReadSet } from '../benchmark/plan.js';
import { hubOf } from '../benchmark/fixture.js';

/** What names a row in the order: its relationship type and the ID that tells it from the others (a stored edge's own, an aggregate's neighbor). */
export function labelOf(edge: GraphEdge): string {
  if ('stableId' in edge.ref) return `${edge.type}:${edge.ref.stableId}`;
  if ('aggregate' in edge.ref) return `${edge.type}:${edge.ref.aggregate.to.stableId}`;
  throw new Error('a row that is neither stored nor an aggregate');
}

const range = (count: number): number[] => Array.from({ length: count }, (_, index) => index + 1);
const byTextDescending = (labels: string[]): string[] => labels.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));

/**
 * The order the fixture's rows must come in, from how the fixture is built: stored dated rows by time (the later the relationship number, the later the time), then dated aggregates by their latest time,
 * then stored undated rows by ID text, then undated aggregates by neighbor ID text, all descending. An aggregate of the dated type groups ten relationships by their number modulo the number of neighbors.
 */
export function expectedOrder(set: ReadSet, size: number): string[] {
  const hub = hubOf(size);
  const neighbors = size / MEMBERS_PER_NEIGHBOR;
  const dated = range(size)
    .reverse()
    .map((index) => `LINKED:l-${hub}-${index}`);
  const stored = byTextDescending(range(size).map((index) => `TIED:t-${hub}-${index}`));
  // the latest relationship of a neighbor is the largest number with its residue; residue 0 is the last relationship
  const latest = (neighbor: number): number => (neighbor === 1 ? size : size - neighbors + (neighbor - 1));
  const aggregate = range(neighbors)
    .sort((a, b) => latest(b) - latest(a))
    .map((neighbor) => `NOTED:${hub}-${neighbor}`);
  const plain = byTextDescending(range(size).map((index) => `PAID:${hub}-${index}`));
  switch (set) {
    case 'dated':
      return dated;
    case 'undated':
      return stored;
    case 'aggregate':
      return aggregate;
    case 'plain':
      return plain;
    case 'all':
      return [...dated, ...aggregate, ...stored, ...plain];
    default: {
      const unreachable: never = set;
      throw new Error(`no order for ${String(unreachable)}`);
    }
  }
}
