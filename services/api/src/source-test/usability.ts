import type { DegreeChecks, SourceTestReport } from '@neburyx/contracts';

/** What the running server knows about a source's mapping: `usable`, `unusable` (a check found it does not fit), or `unchecked` (no check since this process started). */
export type Verdict = 'usable' | 'unusable' | 'unchecked';

/** What the gate asks: whether a data read may go to the source. */
export interface SourceUsability {
  isUsable(sourceId: string): boolean;
}

/** The part of a stored check that sets the verdict. */
export type VerdictCheck = Pick<SourceTestReport, 'sourceId' | 'checkedAt' | 'server' | 'mappingChecks'> & { readonly degreeChecks?: DegreeChecks };

/** What the latest check that reached a source showed about how the server answers a count of neighbors. */
export interface DegreeVerdicts {
  /** True when the check showed the server to answer a count from the degree of the node for this entity type, for every one of these relationship types; false when it showed otherwise, could not tell, did not run, or did not list the type. */
  isCheap(sourceId: string, entityType: string, relationshipTypes: readonly string[]): boolean;
  /** Rises every time a check changes what `isCheap` answers for the source, so an answer made under an older verdict can be told apart. */
  revisionOf(sourceId: string): number;
}

/** No check has shown any degree to be cheap, so every preview is bounded. */
export const NO_DEGREE_VERDICTS: DegreeVerdicts = { isCheap: () => false, revisionOf: () => 0 };

export interface UsabilityRecord extends SourceUsability, DegreeVerdicts {
  verdictOf(sourceId: string): Verdict;
  /** Takes the verdict of a check that reached the source; an older check than the one held, or one that did not reach the source, changes nothing. */
  observe(check: VerdictCheck): void;
  /** Drops what the record holds about cheap degrees, as a stored check made at `checkedAt` whose report cannot be read shows nothing: every preview is bounded until a readable check made after it arrives. A check older than the one held, or than the one already forgotten, changes nothing. */
  forgetDegrees(sourceId: string, checkedAt: string): void;
}

interface Held {
  readonly verdict: Verdict;
  readonly checkedAt: string;
  /** The relationship types whose degree the check showed to be cheap, by entity type. */
  readonly cheap: ReadonlyMap<string, ReadonlySet<string>>;
  readonly revision: number;
}

/** The time of the newest stored check whose report could not be read: what a check made before it says about degrees is not used. */
type Floors = Map<string, string>;

function cheapOf(degrees: DegreeChecks | undefined): Map<string, Set<string>> {
  return new Map((degrees?.types ?? []).filter((entry) => entry.result === 'cheap').map((entry) => [entry.entityType, new Set(entry.relationshipTypes)]));
}

const signatureOf = (cheap: ReadonlyMap<string, ReadonlySet<string>>): string => JSON.stringify([...cheap].map(([entityType, types]) => [entityType, [...types].sort()]).sort());

/** A record in which every source is `unchecked`: for a process that runs system-scope templates only. */
export const ALL_UNCHECKED: SourceUsability = { isUsable: () => false };

/**
 * The verdict is only ever moved by a check that reached the source and is newer than the one that set it, so pruning the history, a refresh that began
 * before a newer check was stored, and a check that did not settle cannot change it.
 */
export function createUsabilityRecord(): UsabilityRecord {
  const held = new Map<string, Held>();
  const floors: Floors = new Map();
  return {
    isUsable: (sourceId) => held.get(sourceId)?.verdict === 'usable',
    verdictOf: (sourceId) => held.get(sourceId)?.verdict ?? 'unchecked',
    observe(check) {
      if (check.server === null) return;
      const current = held.get(check.sourceId);
      if (current !== undefined && Date.parse(check.checkedAt) < Date.parse(current.checkedAt)) return;
      const floor = floors.get(check.sourceId);
      const cheap = floor !== undefined && Date.parse(check.checkedAt) < Date.parse(floor) ? new Map<string, Set<string>>() : cheapOf(check.degreeChecks);
      const revision = (current?.revision ?? 0) + (signatureOf(cheap) === signatureOf(current?.cheap ?? new Map()) ? 0 : 1);
      held.set(check.sourceId, { verdict: check.mappingChecks.status === 'fail' ? 'unusable' : 'usable', checkedAt: check.checkedAt, cheap, revision });
    },
    isCheap(sourceId, entityType, relationshipTypes) {
      const types = held.get(sourceId)?.cheap.get(entityType);
      return types !== undefined && relationshipTypes.every((type) => types.has(type));
    },
    revisionOf: (sourceId) => held.get(sourceId)?.revision ?? 0,
    forgetDegrees(sourceId, checkedAt) {
      const current = held.get(sourceId);
      const floor = floors.get(sourceId);
      if ((current !== undefined && Date.parse(checkedAt) < Date.parse(current.checkedAt)) || (floor !== undefined && Date.parse(checkedAt) < Date.parse(floor))) return;
      floors.set(sourceId, checkedAt);
      if (current !== undefined && current.cheap.size > 0) held.set(sourceId, { ...current, cheap: new Map(), revision: current.revision + 1 });
    },
  };
}
