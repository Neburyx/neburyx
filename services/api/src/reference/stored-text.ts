import { isStorableText } from './well-formed.js';

const MARKER = '~e1:';

/**
 * The text an entity ID is stored as in PostgreSQL, a `text` column and the JSON documents, none of which can hold a NUL or an unpaired surrogate. An ID that can be held is stored as it is; any other, and
 * any that starts like the marker, is stored as the marker and the base64url of its UTF-16 code units, so every ID comes back exactly.
 */
export const encodeStored = (text: string): string => (isStorableText(text) && !text.startsWith(MARKER) ? text : `${MARKER}${Buffer.from(text, 'utf16le').toString('base64url')}`);

/** The ID a stored text stands for; a text that starts with the marker and is not its canonical encoding is an ID as it is. */
export function decodeStored(stored: string): string {
  if (!stored.startsWith(MARKER)) return stored;
  const encoded = stored.slice(MARKER.length);
  const bytes = Buffer.from(encoded, 'base64url');
  if (bytes.toString('base64url') !== encoded || bytes.length % 2 !== 0) return stored;
  // only what `encodeStored` makes is decoded: a stored text that is an ID which merely looks like an encoding stays that ID
  const decoded = bytes.toString('utf16le');
  return encodeStored(decoded) === stored ? decoded : stored;
}
