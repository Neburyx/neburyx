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
export const NO_STORED_RELATIONSHIPS_DRAWN = 'No stored relationships of this entity are drawn.';
export const STORED_RELATIONSHIP = 'Stored relationship';
export const ID_LABEL = 'ID';
export const OBSERVED_LABEL = 'Observed';
export const SOURCE_LABEL = 'Source';
export const SERVER_LABEL = 'Server';

/** The one sentence the panel says about why a stored relationship is there: only what the source holds, never an event it does not describe. */
export function reasonSentence(type: string, from: string, to: string): string {
  return `The source records this ${type} relationship from ${from} to ${to}.`;
}
