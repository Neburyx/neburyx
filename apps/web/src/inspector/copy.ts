export const INSPECTOR_TITLE = 'Inspector';
export const CLOSE_INSPECTOR = 'Close inspector';
export const MORE_ACTIONS = 'More actions';
export const UNMAPPED_INSPECTOR_TEXT = 'The mapping no longer covers this item, so it is not read from the source. It stays in this investigation and shows again if the mapping covers it.';
export const READING_DETAILS = 'Reading details…';
export const DETAILS_NOT_READ = 'Some details could not be read.';
export const UNAVAILABLE = 'unavailable';
export const NO_KEY_PROPERTIES = 'No key properties are mapped for this type.';
export const SOURCE_RECORDS = 'Source records';
export const NO_ZONE = '(no time zone)';
export const COPY_ALL_LABEL = 'Copy all properties';

export function copyLabel(property: string): string {
  return `Copy ${property}`;
}
export const COPY_ALL = 'Copy all';
export const COUNTING_NEIGHBORS = 'Counting neighbors…';
export const NOT_COUNTED = 'Neighbors were not counted.';
export const SOURCED_NEIGHBORS = 'Sourced neighbors';

/** The label a quality flag of an entity has; a flag the web does not know has none and is not shown. */
export const QUALITY_LABELS: ReadonlyMap<string, { readonly label: string; readonly sentence: string | undefined }> = new Map([
  ['duplicate-stable-id', { label: 'More than one entity has this ID', sentence: 'The source holds more than one entity of this type with this ID; the one shown is the first the source returns.' }],
  ['missing-property', { label: 'Some mapped properties are missing', sentence: undefined }],
  ['title-incomplete', { label: 'The title is incomplete', sentence: undefined }],
]);
export const RELATIONSHIPS = 'Relationships';
export const NO_RELATIONSHIPS_DRAWN = 'No relationships of this entity are drawn.';
export const SHOW_MORE = 'Show more';
export const RULE_DERIVED_GROUP = 'Rule-derived';
export const ORIGIN_NOT_STATED_GROUP = 'Origin not stated';
export const RULE_DERIVED = 'rule-derived';
export const FROM_THIS_ENTITY = 'from this entity';
export const TO_THIS_ENTITY = 'to this entity';

export function leftOutText(count: number): string {
  return `${count} loaded ${count === 1 ? 'relationship is' : 'relationships are'} hidden or filtered out of the view`;
}
export const COUNTING_DERIVED = 'Counting rule-derived neighbors…';
export const LINKED = 'Linked';
