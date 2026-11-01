// RFC 9110: etagc = %x21 / %x23-7E / obs-text; list elements are separated by a comma and optional space or tab.
const ENTITY_TAG = /[ \t]*((?:W\/)?"[\x21\x23-\x7e\x80-\xff]*")[ \t]*(,|$)/y;
const WEAK_PREFIX = 'W/';

function parseTags(header: string): string[] | undefined {
  const tags: string[] = [];
  ENTITY_TAG.lastIndex = 0;
  while (ENTITY_TAG.lastIndex < header.length) {
    const match = ENTITY_TAG.exec(header);
    if (match === null || match[1] === undefined) return undefined;
    tags.push(match[1]);
    if (match[2] === '') break;
  }
  return tags.length > 0 ? tags : undefined;
}

/** True when the header is `*`, or a well-formed list of entity tags that holds the current tag (weak forms compare by their opaque tag). */
export function matchesEntityTag(header: unknown, tag: string): boolean {
  if (typeof header !== 'string') return false;
  if (header.replace(/^[ \t]+|[ \t]+$/g, '') === '*') return true;
  const tags = parseTags(header);
  return tags !== undefined && tags.some((candidate) => (candidate.startsWith(WEAK_PREFIX) ? candidate.slice(WEAK_PREFIX.length) : candidate) === tag);
}
