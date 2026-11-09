export const EVIDENCE_PANEL_TITLE = 'Relationship evidence';
export const WHY_HERE = 'Why is this relationship here?';
export const VIEW_SUPPORTING_RECORDS = 'View supporting records';
export const CLOSE_EVIDENCE = 'Close relationship evidence';
export const SELECTED_READ_ONLY = 'Selected relationship · source is read-only';
export const READ_ONLY = 'Source is read-only';
export const TAB_EVIDENCE = 'Evidence';
export const TAB_PROPERTIES = 'Properties';
export const TAB_SOURCE = 'Source';
export const READING_EVIDENCE = 'Reading the evidence…';
export const SUPPORTING_RECORDS = 'Supporting source records:';
export const NOT_AVAILABLE_BADGE = 'unavailable';
export const NOT_AVAILABLE_TITLE = 'Evidence not available';
export const NOT_AVAILABLE_TEXT = 'For legacy edges without retained source records.';
export const TRY_AGAIN = 'Try again';
export const NO_EVIDENCE_RELATIONSHIPS_DRAWN = 'No stored or derived relationships of this entity are drawn.';
export const STORED_RELATIONSHIP = 'Stored relationship';
export const ID_LABEL = 'ID';
export const OBSERVED_LABEL = 'Observed';
export const SOURCE_LABEL = 'Source';
export const SERVER_LABEL = 'Server';

/** The one sentence the panel says about why a stored relationship is there: only what the source holds, never an event it does not describe. */
export function reasonSentence(type: string, from: string, to: string): string {
  return `The source records this ${type} relationship from ${from} to ${to}.`;
}

export const DERIVED_RELATIONSHIP = 'Derived relationship';
export const SUPPORTING_RELATIONSHIPS = 'Supporting relationships';
export const NO_CONFIDENCE_SCORE = 'No confidence score';
export const NO_STABLE_ID_TEXT = 'No stable ID in the source: its records are not listed';
export const NOT_AVAILABLE_ROW = 'Evidence not available';
export const RULE_LABEL = 'Rule';
export const RULE_VERSION_LABEL = 'Rule version';
export const FROM_LABEL = 'From';
export const TO_LABEL = 'To';
export const SUPPORTS_LABEL = 'Supports';

/** The sentence that explains a derivation, in one form for a rule with one entity in the middle of its chain and one for a longer chain; the names of the types are the ones the answer gave. */
export function derivationSentence(ruleId: string, version: number, from: string, to: string, middleTypes: readonly string[]): string {
  const head = `Derived by rule ${ruleId} (version ${version}). ${from} and ${to} are linked through`;
  const [only, ...rest] = middleTypes;
  if (only === undefined) return `${head} the supports shown below.`;
  if (rest.length === 0) return `${head} the shared ${only} shown below.`;
  return `${head} the ${[only, ...rest].join(' and ')} shown below.`;
}

/** The count of the groups of supports with its quality: the number and "exact", or "≥ n" and "lower bound"; the groups are the unit. */
export function groupsCountText(value: number, quality: 'exact' | 'lowerBound'): string {
  const unit = value === 1 ? 'group' : 'groups';
  return quality === 'exact' ? `${value} ${unit} · exact` : `≥ ${value} ${unit} · lower bound`;
}
