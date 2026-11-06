import { MAX_CASE_REF_LENGTH, MAX_STABLE_ID_LENGTH, pathSegmentOf, valueOfPathSegment } from '@neburyx/contracts';

export interface DeepLink {
  readonly sourceId: string;
  readonly entityType: string;
  readonly stableId: string;
  readonly caseRef?: string;
}

export type ReadLink = { readonly ok: true; readonly link: DeepLink } | { readonly ok: false; readonly reason: 'malformed' | 'foreign' };

export const DEEP_LINK_ENTITY_SEGMENT = 'entity';
export const CASE_REF_PARAMETER = 'caseRef';

export const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const PATH = /^\/([^/?#]+)\/entity\/([^/?#]+)\/([^/?#]+)(?:\?([^#]*))?$/;
export const characters = (value: string): number => [...value].length;
const encoded = (value: string): string => encodeURIComponent(pathSegmentOf(value));
const MALFORMED: ReadLink = { ok: false, reason: 'malformed' };
const FOREIGN: ReadLink = { ok: false, reason: 'foreign' };

function decoded(segment: string): string | undefined {
  try {
    return valueOfPathSegment(decodeURIComponent(segment));
  } catch {
    return undefined;
  }
}

function caseRefOf(query: string | undefined): string | undefined | null {
  if (query === undefined) return undefined;
  const pairs = query.split('&');
  const [pair] = pairs;
  if (pairs.length !== 1 || pair === undefined) return null;
  const at = pair.indexOf('=');
  if (at < 0 || pair.slice(0, at) !== CASE_REF_PARAMETER) return null;
  try {
    const value = decodeURIComponent(pair.slice(at + 1));
    return value === '' || characters(value) > MAX_CASE_REF_LENGTH ? null : value;
  } catch {
    return null;
  }
}

/** Reads text as a link of this app: a path, or an address of `origin`; the host of anything else is never followed. */
export function readDeepLink(text: string, origin: string): ReadLink {
  const trimmed = text.trim();
  if (trimmed.includes('\\') || trimmed.startsWith('//')) return FOREIGN;
  let local = trimmed;
  if (SCHEME.test(trimmed)) {
    let address: URL;
    try {
      address = new URL(trimmed);
    } catch {
      return FOREIGN;
    }
    if ((address.protocol !== 'http:' && address.protocol !== 'https:') || address.origin !== origin) return FOREIGN;
    local = `${address.pathname}${address.search}${address.hash}`;
  } else if (!trimmed.startsWith('/')) {
    return MALFORMED;
  }
  const matched = PATH.exec(local);
  if (matched === null) return MALFORMED;
  const [, sourceId, rawType, rawId, query] = matched;
  const entityType = decoded(rawType ?? '');
  const stableId = decoded(rawId ?? '');
  const caseRef = caseRefOf(query);
  if (sourceId === undefined || !SOURCE_ID.test(sourceId) || entityType === undefined || stableId === undefined || caseRef === null) return MALFORMED;
  if (characters(stableId) > MAX_STABLE_ID_LENGTH || characters(entityType) > MAX_STABLE_ID_LENGTH) return MALFORMED;
  return { ok: true, link: { sourceId, entityType, stableId, ...(caseRef === undefined ? {} : { caseRef }) } };
}

/** The path of a link, made with the shared path-segment pair and one percent-encoding. */
export function deepLinkPath(link: DeepLink): string {
  const query = link.caseRef === undefined ? '' : `?${CASE_REF_PARAMETER}=${encodeURIComponent(link.caseRef)}`;
  return `/${link.sourceId}/${DEEP_LINK_ENTITY_SEGMENT}/${encoded(link.entityType)}/${encoded(link.stableId)}${query}`;
}
