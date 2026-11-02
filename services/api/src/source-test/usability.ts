import type { SourceTestReport } from '@neburyx/contracts';

/** What the running server knows about a source's mapping: `usable`, `unusable` (a check found it does not fit), or `unchecked` (no check since this process started). */
export type Verdict = 'usable' | 'unusable' | 'unchecked';

/** What the gate asks: whether a data read may go to the source. */
export interface SourceUsability {
  isUsable(sourceId: string): boolean;
}

/** The part of a stored check that sets the verdict. */
export type VerdictCheck = Pick<SourceTestReport, 'sourceId' | 'checkedAt' | 'server' | 'mappingChecks'>;

export interface UsabilityRecord extends SourceUsability {
  verdictOf(sourceId: string): Verdict;
  /** Takes the verdict of a check that reached the source; an older check than the one held, or one that did not reach the source, changes nothing. */
  observe(check: VerdictCheck): void;
}

interface Held {
  readonly verdict: Verdict;
  readonly checkedAt: string;
}

/** A record in which every source is `unchecked`: for a process that runs system-scope templates only. */
export const ALL_UNCHECKED: SourceUsability = { isUsable: () => false };

/**
 * The verdict is only ever moved by a check that reached the source and is newer than the one that set it, so pruning the history, a refresh that began
 * before a newer check was stored, and a check that did not settle cannot change it.
 */
export function createUsabilityRecord(): UsabilityRecord {
  const held = new Map<string, Held>();
  return {
    isUsable: (sourceId) => held.get(sourceId)?.verdict === 'usable',
    verdictOf: (sourceId) => held.get(sourceId)?.verdict ?? 'unchecked',
    observe(check) {
      if (check.server === null) return;
      const current = held.get(check.sourceId);
      if (current !== undefined && Date.parse(check.checkedAt) < Date.parse(current.checkedAt)) return;
      held.set(check.sourceId, { verdict: check.mappingChecks.status === 'fail' ? 'unusable' : 'usable', checkedAt: check.checkedAt });
    },
  };
}
