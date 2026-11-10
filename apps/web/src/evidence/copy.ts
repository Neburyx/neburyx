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

export const AGGREGATE_RELATIONSHIP = 'Aggregate relationship';
export const NO_STABLE_ID_SENTENCE = 'The source has no stable ID for this relationship type.';
export const FIRST_OBSERVED_LABEL = 'First observed';
export const LAST_OBSERVED_LABEL = 'Last observed';
export const MEMBERS_LABEL = 'Members';
export const SAMPLE_ORDER_LABEL = 'Sample order';
export const MEMBERS_NOT_COUNTED = 'Members · not counted';
export const OPEN_AGGREGATE_EVIDENCE = 'Evidence';
export const EMPTY_MEMBER = 'No observed time or mapped property to show';

/** The sentence for an aggregate of a type that has a stable ID in the mapping but whose relationships here have none the source can use. */
export const unusableIdSentence = (type: string): string => `These ${type} relationships have no usable stable ID in the source.`;

/** The line that says what the member count covers: every relationship of the type between the two ends, whatever filters the view applied. */
export const membersScopeLine = (type: string): string => `Counts every ${type} relationship between these two, whatever the view's filters.`;

export const membersText = (value: number): string => `${MEMBERS_LABEL} ${value.toLocaleString('en-US')} · exact`;

/** The heading of the sample, which names the order that was used and says "most recent" only when the rows are ordered by observed time. */
export function sampleHeading(order: 'observed-newest' | 'source-order', shown: number): string {
  return order === 'observed-newest' ? `Sample · first ${shown} by most recent observed time` : `Sample · ${shown} ${shown === 1 ? 'member' : 'members'}, in the source's order`;
}

export const sampleOrderText = (order: 'observed-newest' | 'source-order'): string => (order === 'observed-newest' ? 'Most recent observed time first' : "The source's order");

export const moreInSampleLine = (more: number): string => `… ${more.toLocaleString('en-US')} more in this sample. There is no paging.`;

export const aggregateEvidenceLabel = (type: string, from: string, to: string): string => `Evidence of ${type}: ${from} → ${to}`;
