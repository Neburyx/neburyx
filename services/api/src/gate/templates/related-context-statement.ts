import { AppError } from '../../errors.js';
import { quoteName } from '../render.js';
import type { SourceAllowlist } from '../types.js';

/** The parameter the gate fills with the branches of a relationship context statement, in branch order: the entity types of the hit and of the exact match and the relationship, so a branch's text holds the position of its own and no name. */
export const CONTEXT_BRANCHES = 'contextBranches';

export interface ContextBranch {
  readonly hitType: string;
  readonly exactType: string;
  readonly type: string;
  /** From the hit's side: `out` when the relationship leaves the hit. */
  readonly direction: 'out' | 'in';
}

/**
 * The mapping rows that join an entity type present among the hits to one present among the exact matches, in the mapping's order, and for each row `out` before `in`: the order that chooses which
 * relationship a hit shows. A row that joins a type to itself is read in both directions.
 */
export function contextBranchesOf(allowlist: SourceAllowlist, hitTypes: ReadonlySet<string>, exactTypes: ReadonlySet<string>): readonly ContextBranch[] {
  const branches: ContextBranch[] = [];
  for (const row of allowlist.relationshipRows) {
    for (const hitType of hitTypes) {
      for (const exactType of exactTypes) {
        if (row.from === hitType && row.to === exactType) branches.push({ hitType, exactType, type: row.type, direction: 'out' });
        if (row.to === hitType && row.from === exactType) branches.push({ hitType, exactType, type: row.type, direction: 'in' });
      }
    }
  }
  return branches;
}

function branchOf(branch: ContextBranch, position: number, allowlist: SourceAllowlist): string {
  const hitLabel = allowlist.entityLabels.get(branch.hitType);
  const hitId = allowlist.stableIds.get(branch.hitType);
  const exactLabel = allowlist.entityLabels.get(branch.exactType);
  const exactId = allowlist.stableIds.get(branch.exactType);
  if (hitLabel === undefined || hitId === undefined || exactLabel === undefined || exactId === undefined) throw new AppError('INVALID_REQUEST');
  const pattern = branch.direction === 'out' ? `(a)-[:${quoteName(branch.type)}]->(m)` : `(a)<-[:${quoteName(branch.type)}]-(m)`;
  const own = `$${CONTEXT_BRANCHES}[${position}]`;
  return [
    'UNWIND range(0, size($hits) - 1) AS hi',
    `WITH hi, $hits[hi] AS h WHERE h.entityType = ${own}.hitType`,
    `MATCH (a:${quoteName(hitLabel)}) WHERE a.${quoteName(hitId)} IN [h.stableId, h.stableInteger]`,
    'WITH hi, a',
    'UNWIND range(0, size($exact) - 1) AS ei',
    `WITH hi, a, ei, $exact[ei] AS e WHERE e.entityType = ${own}.exactType`,
    `MATCH (m:${quoteName(exactLabel)}) WHERE m.${quoteName(exactId)} IN [e.stableId, e.stableInteger] AND a <> m AND EXISTS { ${pattern} }`,
    `RETURN hi, ${position} AS bi, ei, ${own}.type AS rtype, ${own}.direction AS dir`,
  ].join(' ');
}

/**
 * The statement of the relationship context read: one branch for each mapping row and direction, joined by `UNION ALL` in one `CALL`, then for each hit the first row in the order (branch, then exact match), at most one row for each
 * hit. Both ends are found by their stable ID, so the relationship is looked for between two known nodes, and `EXISTS` stops at the first relationship of a pair. A row names the hit and the exact
 * match by their position in the lists, which the caller maps back to the references it sent.
 */
export function relatedContextStatementOf(allowlist: SourceAllowlist, branches: readonly ContextBranch[]): string {
  if (branches.length === 0) throw new AppError('INVALID_REQUEST');
  return [
    `CALL { ${branches.map((branch, position) => branchOf(branch, position, allowlist)).join(' UNION ALL ')} }`,
    'WITH hi, bi, ei, rtype, dir ORDER BY hi, bi, ei',
    'WITH hi, collect([bi, ei, rtype, dir])[0] AS best',
    'RETURN hi, best[0] AS bi, best[1] AS ei, best[2] AS rtype, best[3] AS dir ORDER BY hi LIMIT $limit + 1',
  ].join('\n');
}
