import { type AskPatternCatalog, type AskPatternEntry, type AskPatternListing } from '@neburyx/contracts';
import { PATTERN_CATALOG_CUT_SENTENCE } from './catalog-text.js';
import { describeProjection } from './describe.js';

/** What a key stood for in one request: the pattern's own id and version, held by the route and never sent. */
interface PatternTarget {
  readonly id: string;
  readonly version: number;
}

export interface BuiltPatternCatalog {
  readonly catalog: AskPatternCatalog;
  readonly targets: ReadonlyMap<string, PatternTarget>;
}

/**
 * The catalog of the saved patterns offered for one question. Each pattern gets a key by the order of its description (then the order it was offered in), so the key says nothing of the pattern's id, owner, name or age;
 * the text holds the descriptions and keys only, because a description is built from the projection, which has no field for anything typed.
 */

export function buildPatternCatalog(listing: AskPatternListing): BuiltPatternCatalog | undefined {
  const { offers } = listing;
  if (offers.length === 0) return undefined;
  const described = offers.map((offer, position) => ({ offer, position, text: describeProjection(offer.projection), label: offer.name }));
  const order = (left: string, right: string): number => (left === right ? 0 : left < right ? -1 : 1);
  described.sort((left, right) => order(left.text, right.text) || order(left.label ?? '', right.label ?? '') || left.position - right.position);
  const entries = new Map<string, AskPatternEntry>();
  const targets = new Map<string, PatternTarget>();
  const lines = described.map(({ offer, text, label }, index) => {
    const key = `pat_${index + 1}`;
    entries.set(key, { anchorType: offer.projection.anchorType, startingEntity: offer.projection.startingEntity });
    targets.set(key, { id: offer.id, version: offer.version });
    return label === undefined ? `${key}: ${text}` : `${key}, named ${JSON.stringify(label)}: ${text}`;
  });
  const tail = listing.cut ? `\n${PATTERN_CATALOG_CUT_SENTENCE}` : '';
  const text = `${lines.join('\n')}${tail}\n\n`;
  return { catalog: { text, entries, cut: listing.cut }, targets };
}
