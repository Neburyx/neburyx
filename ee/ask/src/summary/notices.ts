import type { TemplateRunNotice } from '@neburyx/contracts';

/** One fixed sentence for each notice a template run carries. A notice this module does not know is left out, and never made up. */
export function noticeSentence(notice: TemplateRunNotice): string | undefined {
  switch (notice.code) {
    case 'stopListSkipped':
      return 'An attribute on the source’s stop list was skipped.';
    case 'noStopList':
      return 'The source has no stop list for this pattern.';
    case 'undatedExcluded':
      return 'Relationships without a usable date are outside the window.';
    case 'readBounded':
      return 'The read was cut, so the count is a lower bound.';
    case 'evidenceCut':
      return 'Not every shared attribute is listed.';
    case 'windowNotApplied':
      return `The window did not apply to ${notice.relationshipTypes.length} relationship ${notice.relationshipTypes.length === 1 ? 'type' : 'types'}.`;
    case 'supernodesSkipped':
      return `${notice.entities.length} ${notice.entities.length === 1 ? 'supernode was' : 'supernodes were'} not traversed.`;
    default:
      return undefined;
  }
}
