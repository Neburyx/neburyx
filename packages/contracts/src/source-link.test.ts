import { describe, expect, it } from 'vitest';
import { edgeRefSegmentOf, MAX_EDGE_REF_SEGMENT } from './edge-detail.js';
import { parseSourceLinkSegment, sourceLinkQuerySchema, sourceLinkSegmentOf } from './source-link.js';

const entity = { sourceId: 'demo', entityType: 'widget', stableId: 'W-1' };
const stored = { sourceId: 'demo', type: 'MADE_FROM', from: 'widget', to: 'gadget', stableId: 'L-1' };

describe('the source link segment', () => {
  it('round-trips an entity reference and a stored edge reference and tells them apart', () => {
    expect(parseSourceLinkSegment(sourceLinkSegmentOf({ form: 'entity', ref: entity }))).toEqual({ form: 'entity', ref: entity });
    expect(parseSourceLinkSegment(sourceLinkSegmentOf({ form: 'stored', ref: stored }))).toEqual({ form: 'stored', ref: stored });
  });

  it('reads the segment a stored edge route builds', () => {
    expect(parseSourceLinkSegment(edgeRefSegmentOf(stored))).toEqual({ form: 'stored', ref: stored });
  });

  it('refuses text that is not base64url JSON, an extra key, an aggregate or derived reference, and a segment over the bound', () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const end = (entityType: string) => ({ sourceId: 'demo', entityType, stableId: 'X' });
    for (const text of ['', '!!', 'e30', encode({ ...entity, extra: 1 }), encode({ ...stored, extra: 1 }), encode({ sourceId: 'demo', type: 'USES', from: end('a'), to: end('b') }), encode({ sourceId: 'demo', type: 'USES', from: end('a'), to: end('b'), ruleId: 'r', ruleVersion: 1 }), 'a'.repeat(MAX_EDGE_REF_SEGMENT + 1)]) {
      expect(parseSourceLinkSegment(text), text.slice(0, 20)).toBeUndefined();
    }
  });
});

describe('the source link query', () => {
  it('allows mask and record only, and a record of 1 to 100000 characters', () => {
    expect(sourceLinkQuerySchema.safeParse({ mask: 'true', record: 'R-1' }).success).toBe(true);
    expect(sourceLinkQuerySchema.safeParse({}).success).toBe(true);
    for (const query of [{ other: '1' }, { record: '' }, { record: 'x'.repeat(100_001) }, { mask: 'yes' }]) expect(sourceLinkQuerySchema.safeParse(query).success).toBe(false);
  });
});
