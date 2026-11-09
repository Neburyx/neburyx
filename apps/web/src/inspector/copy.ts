export const INSPECTOR_TITLE = 'Inspector';
export const CLOSE_INSPECTOR = 'Close inspector';
export const MORE_ACTIONS = 'More actions';
export const READING_DETAILS = 'Reading details…';
export const DETAILS_NOT_READ = 'Some details could not be read.';
export const UNAVAILABLE = 'unavailable';
export const NO_KEY_PROPERTIES = 'No key properties are mapped for this type.';
export const SOURCE_RECORDS = 'Source records';
export const NO_ZONE = '(no time zone)';
export const COPY = 'Copy';
export const COPY_ALL = 'Copy all';
export const COPIED = 'Copied';
export const COULD_NOT_COPY = 'Could not copy';
export const COUNTING_NEIGHBORS = 'Counting neighbors…';
export const NOT_COUNTED = 'Neighbors were not counted.';
export const SOURCED_NEIGHBORS = 'Sourced neighbors';

/** The label a quality flag of an entity has; a flag the web does not know has none and is not shown. */
export const QUALITY_LABELS: ReadonlyMap<string, { readonly label: string; readonly sentence: string | undefined }> = new Map([
  ['duplicate-stable-id', { label: 'More than one entity has this ID', sentence: 'The source holds more than one entity of this type with this ID; the one shown is the first the source returns.' }],
  ['missing-property', { label: 'Some mapped properties are missing', sentence: undefined }],
  ['title-incomplete', { label: 'The title is incomplete', sentence: undefined }],
]);
