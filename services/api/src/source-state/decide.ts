import { NOT_CHECKED_SINCE_START } from '../source-test/reasons.js';

/** One stored check of a source, as the rule needs it. */
export interface StoredCheck {
  readonly id: string;
  /** The time the check says it was made, as an ISO string. */
  readonly checkedAt: string;
  readonly identityHash: string | null;
  readonly configHash: string | null;
  /** True when the check reached the source. */
  readonly reachedSource: boolean;
  readonly state: string | null;
  readonly stateReason: string | null;
}

/** The connection and the mapping of a source as the evaluating process runs it. */
export interface SourceHashes {
  readonly identityHash: string;
  readonly configHash: string;
}

export interface ShownState {
  readonly state: string;
  readonly stateReason: string | null;
  /** The check that decided, or null when none qualifies and the state is the not-checked fallback. */
  readonly decidedBy: string | null;
}

const NOT_CHECKED: ShownState = { state: 'unknown', stateReason: NOT_CHECKED_SINCE_START, decidedBy: null };

function qualifies(check: StoredCheck, source: SourceHashes): boolean {
  return check.reachedSource && check.identityHash === source.identityHash && check.configHash === source.configHash;
}

/** True when `a` is newer than `b`: a later time, or the same time and the larger ID. */
function newer(a: StoredCheck, b: StoredCheck): boolean {
  const difference = Date.parse(a.checkedAt) - Date.parse(b.checkedAt);
  return difference !== 0 ? difference > 0 : a.id > b.id;
}

/**
 * The state every API copy shows for a source: that of the newest check, of any copy, that reached the source and was made for the connection and the mapping
 * the copy runs. Equal times go to the larger check ID. The order of `checks` does not matter, and no start time is consulted.
 */
export function decideSourceState(checks: readonly StoredCheck[], source: SourceHashes): ShownState {
  let winner: StoredCheck | undefined;
  for (const check of checks) {
    if (qualifies(check, source) && (winner === undefined || newer(check, winner))) winner = check;
  }
  return winner === undefined ? NOT_CHECKED : { state: winner.state ?? 'unknown', stateReason: winner.stateReason, decidedBy: winner.id };
}
