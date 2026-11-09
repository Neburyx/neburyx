import type { ReactNode } from 'react';
import { sourceLinkSegmentOf, type ElementRef, type SourceProfile, type StoredEdgeRef } from '@neburyx/contracts';

export const OPEN_SOURCE_RECORD = 'Open source record';

const PATH = '/v1/source-links/';

const withQuery = (path: string, parts: readonly string[]): string => (parts.length === 0 ? path : `${path}?${parts.join('&')}`);

/** The app's own address for an entity's source record; the server answers it with the redirect, and the client never holds the address it leads to. */
export function entityLinkHref(ref: ElementRef, mask: boolean): string {
  return withQuery(`${PATH}${encodeURIComponent(sourceLinkSegmentOf({ form: 'entity', ref }))}`, mask ? ['mask=true'] : []);
}

export function recordLinkHref(ref: StoredEdgeRef, record: string, mask: boolean): string {
  return withQuery(`${PATH}${encodeURIComponent(sourceLinkSegmentOf({ form: 'stored', ref }))}`, [`record=${encodeURIComponent(record)}`, ...(mask ? ['mask=true'] : [])]);
}

/** Whether the profile says the entity's type has a link for this masking setting: a keyed type's link holds the value, so it is offered only while unmasked. */
export function offersEntityLink(profile: SourceProfile | undefined, ref: ElementRef, mask: boolean): boolean {
  const flag = profile?.entityTypes.find((type) => type.type === ref.entityType)?.recordLink;
  return flag === 'always' || (flag === 'unmasked' && !mask);
}

export function offersRecordLink(profile: SourceProfile | undefined, ref: StoredEdgeRef): boolean {
  return profile?.relationshipTypes.some((type) => type.type === ref.type && type.from === ref.from && type.to === ref.to && type.recordLink === true) === true;
}

export function openSourceLink(href: string): void {
  window.open(href, '_blank', 'noopener,noreferrer');
}

export function SourceRecordLink({ href, className, children }: { readonly href: string; readonly className?: string; readonly children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className === undefined ? 'source-record-link' : `source-record-link ${className}`}>
      {children}
      <span className="icon icon-open-record" aria-hidden="true" />
    </a>
  );
}
