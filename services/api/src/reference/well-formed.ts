const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** Whether the text is well-formed Unicode, with no unpaired surrogate (what `String.prototype.isWellFormed` tells, which the compiler's library level does not declare). */
export const isWellFormed = (text: string): boolean => !LONE_SURROGATE.test(text);

/** Whether PostgreSQL can hold the text in a `text` column and a JSON document: well-formed, and with no NUL. */
export const isStorableText = (text: string): boolean => isWellFormed(text) && !text.includes('\u0000');

const LONE_SURROGATE_GLOBAL = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** The text with each NUL and unpaired surrogate replaced by U+FFFD, so that text built from source data can be stored. */
export const storableOf = (text: string): string => text.replace(/\u0000/g, '\ufffd').replace(LONE_SURROGATE_GLOBAL, '\ufffd');
