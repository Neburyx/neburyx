import { describe, expect, it } from 'vitest';
import { derivedEdgeDetailSchema, edgeDetailSchema, edgeRefSegmentOf, EVIDENCE_NOT_AVAILABLE, MAX_EDGE_REF_SEGMENT, parseEdgeRefSegment } from './edge-detail.js';

const REF = { sourceId: 'demo', type: 'MADE_FROM', from: 'widget', to: 'gadget', stableId: 'L-1' };
const END = (stableId: string, entityType: string) => ({ ref: { sourceId: 'demo', entityType, stableId }, title: stableId, type: entityType });
const DETAIL = { ref: REF, type: 'MADE_FROM', semantics: 'stored' as const, from: END('W-1', 'widget'), to: END('GT-1', 'gadget'), properties: [], qualityFlags: [], evidence: { status: 'available' as const, records: [{ sourceRecordId: 'R-1', linkable: false }] } };
const encode = (text: string) => btoa(text).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

describe('the segment of a stored edge reference', () => {
  it('round-trips a reference, with the keys in a fixed order and no padding', () => {
    const segment = edgeRefSegmentOf(REF);
    expect(segment).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(atob(segment.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(segment.length / 4) * 4, '='))).toBe('{"sourceId":"demo","type":"MADE_FROM","from":"widget","to":"gadget","stableId":"L-1"}');
    expect(parseEdgeRefSegment(segment)).toEqual(REF);
  });

  it('round-trips text that is not ASCII', () => {
    const ref = { ...REF, stableId: 'Ünï-é-漢字' };
    expect(parseEdgeRefSegment(edgeRefSegmentOf(ref))).toEqual(ref);
  });

  it('accepts a valid encoding with the keys in another order', () => {
    expect(parseEdgeRefSegment(encode('{"stableId":"L-1","to":"gadget","from":"widget","type":"MADE_FROM","sourceId":"demo"}'))).toEqual(REF);
  });

  it.each([
    ['padding', `${edgeRefSegmentOf({ ...REF, stableId: 'L-12' })}=`],
    ['a plus sign', 'ab+c'],
    ['a slash', 'ab/c'],
    ['a space', 'ab c'],
    ['a length no base64 text has', 'abcde'],
    ['an empty text', ''],
    ['text that is not JSON', encode('not json')],
    ['bytes that are not UTF-8', 'gP8'],
    ['an unknown key', encode('{"sourceId":"demo","type":"T","from":"a","to":"b","stableId":"1","x":1}')],
    ['a missing key', encode('{"sourceId":"demo","type":"T","from":"a","to":"b"}')],
    ['an aggregate reference', encode('{"sourceId":"demo","aggregate":{"type":"T","from":{"sourceId":"demo","entityType":"a","stableId":"1"},"to":{"sourceId":"demo","entityType":"b","stableId":"2"}}}')],
    ['a derived reference with an extra field', encode('{"sourceId":"demo","derived":{"ruleId":"R","from":{"sourceId":"demo","entityType":"a","stableId":"1"},"to":{"sourceId":"demo","entityType":"b","stableId":"2"},"x":1}}')],
    ['a derived reference with a missing end', encode('{"sourceId":"demo","derived":{"ruleId":"R","from":{"sourceId":"demo","entityType":"a","stableId":"1"}}}')],
    ['a number', encode('1')],
  ])('refuses %s', (_name, segment) => {
    expect(parseEdgeRefSegment(segment)).toBeUndefined();
  });

  it('refuses a segment over the bound and accepts one at it', () => {
    const at = 'a'.repeat(MAX_EDGE_REF_SEGMENT);
    expect(parseEdgeRefSegment(`${at}a`)).toBeUndefined();
    expect(parseEdgeRefSegment(at)).toBeUndefined();
    const long = { ...REF, stableId: 'x'.repeat(1400) };
    const segment = edgeRefSegmentOf(long);
    expect(segment.length).toBeLessThanOrEqual(MAX_EDGE_REF_SEGMENT);
    expect(parseEdgeRefSegment(segment)).toEqual(long);
  });
});

describe('the edge detail', () => {
  it('holds a stored edge with its evidence', () => {
    expect(edgeDetailSchema.safeParse(DETAIL).success).toBe(true);
  });

  it('holds the not-available state with its code and no records', () => {
    expect(edgeDetailSchema.safeParse({ ...DETAIL, evidence: { status: 'not-available', code: EVIDENCE_NOT_AVAILABLE } }).success).toBe(true);
    expect(edgeDetailSchema.safeParse({ ...DETAIL, evidence: { status: 'not-available', code: EVIDENCE_NOT_AVAILABLE, records: [] } }).success).toBe(false);
    expect(edgeDetailSchema.safeParse({ ...DETAIL, evidence: { status: 'not-available', code: 'NOT_FOUND' } }).success).toBe(false);
  });

  it('refuses an available state with no record, and an unreadable record with a value', () => {
    expect(edgeDetailSchema.safeParse({ ...DETAIL, evidence: { status: 'available', records: [] } }).success).toBe(false);
    expect(edgeDetailSchema.safeParse({ ...DETAIL, evidence: { status: 'available', records: [{ property: 'p', unreadable: true }] } }).success).toBe(true);
    expect(edgeDetailSchema.safeParse({ ...DETAIL, evidence: { status: 'available', records: [{ property: 'p', unreadable: true, sourceRecordId: 'R' }] } }).success).toBe(false);
  });

  it.each(['confidence', 'score', 'derivation', 'memberCount', 'url', 'elementId'])('has no field %s', (field) => {
    expect(edgeDetailSchema.safeParse({ ...DETAIL, [field]: 1 }).success).toBe(false);
  });

  it('refuses a source-record link in a record', () => {
    expect(edgeDetailSchema.safeParse({ ...DETAIL, evidence: { status: 'available', records: [{ sourceRecordId: 'R-1', linkable: true, url: 'https://x' }] } }).success).toBe(false);
  });
});

const DERIVED_REF = { sourceId: 'demo', derived: { ruleId: 'shared', from: { sourceId: 'demo', entityType: 'widget', stableId: 'W-1' }, to: { sourceId: 'demo', entityType: 'widget', stableId: 'W-2' } } };

describe('the segment of a derived edge reference', () => {
  it('round-trips, with the keys in a fixed order whatever the order of the object', () => {
    const segment = edgeRefSegmentOf(DERIVED_REF);
    const shuffled = { derived: { to: DERIVED_REF.derived.to, from: { stableId: 'W-1', entityType: 'widget', sourceId: 'demo' }, ruleId: 'shared' }, sourceId: 'demo' };
    expect(edgeRefSegmentOf(shuffled)).toBe(segment);
    expect(atob(segment.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(segment.length / 4) * 4, '='))).toBe(
      '{"sourceId":"demo","derived":{"ruleId":"shared","from":{"sourceId":"demo","entityType":"widget","stableId":"W-1"},"to":{"sourceId":"demo","entityType":"widget","stableId":"W-2"}}}',
    );
    expect(parseEdgeRefSegment(segment)).toEqual(DERIVED_REF);
  });

  it('keeps the segment of a stored reference as it was', () => {
    expect(edgeRefSegmentOf(REF)).toBe(encode('{"sourceId":"demo","type":"MADE_FROM","from":"widget","to":"gadget","stableId":"L-1"}'));
  });
});

const MIDDLE = END('D-1', 'gizmo');
const stored = (id: string, records = [{ sourceRecordId: `R-${id}`, linkable: false }]) => ({ ref: { ...REF, stableId: id }, type: 'MADE_FROM', from: END('W-1', 'widget'), to: MIDDLE, evidence: { status: 'available' as const, records } });
const aggregate = { ref: { sourceId: 'demo', aggregate: { type: 'PAID', from: MIDDLE.ref, to: END('D-2', 'gizmo').ref } }, type: 'PAID', from: MIDDLE, to: END('D-2', 'gizmo'), evidence: { status: 'no-stable-id' as const } };
const DERIVED = {
  ref: DERIVED_REF,
  type: 'shared',
  semantics: 'derived' as const,
  rule: { id: 'shared', version: 1 },
  from: END('W-1', 'widget'),
  to: END('W-2', 'widget'),
  supports: { count: { value: 1, quality: 'exact' as const, scope: 'derived:supports' }, groups: [{ middle: [MIDDLE], supports: [stored('L-1'), aggregate] }] },
  qualityFlags: [],
  warnings: [],
};

describe('the derived edge detail', () => {
  it('holds a derived edge, and the union still holds a stored one', () => {
    expect(edgeDetailSchema.safeParse(DERIVED).success).toBe(true);
    expect(edgeDetailSchema.safeParse(DETAIL).success).toBe(true);
  });

  it('holds a stored support with the not-available state and an aggregate support with the no-stable-id state', () => {
    const groups = [{ middle: [MIDDLE], supports: [stored('L-1', []), aggregate] }];
    const withoutRecords = { ...DERIVED, supports: { ...DERIVED.supports, groups: [{ middle: [MIDDLE], supports: [{ ...stored('L-1'), evidence: { status: 'not-available', code: EVIDENCE_NOT_AVAILABLE } }, aggregate] }] } };
    expect(derivedEdgeDetailSchema.safeParse(withoutRecords).success).toBe(true);
    expect(derivedEdgeDetailSchema.safeParse({ ...DERIVED, supports: { ...DERIVED.supports, groups } }).success).toBe(false);
  });

  it('refuses a pairing of an aggregate ref with records, and of a stored ref with the no-stable-id state', () => {
    const records = { ...aggregate, evidence: { status: 'available', records: [{ sourceRecordId: 'R', linkable: false }] } };
    const noId = { ...stored('L-1'), evidence: { status: 'no-stable-id' } };
    for (const support of [records, noId]) {
      expect(derivedEdgeDetailSchema.safeParse({ ...DERIVED, supports: { ...DERIVED.supports, groups: [{ middle: [MIDDLE], supports: [support] }] } }).success).toBe(false);
    }
  });

  it.each([['memberCount', { memberCount: { value: 1, quality: 'lowerBound', scope: 'x' } }], ['observedAt', { observedAt: 'x' }], ['properties', { properties: [] }]])('refuses %s on an aggregate support', (_name, extra) => {
    expect(derivedEdgeDetailSchema.safeParse({ ...DERIVED, supports: { ...DERIVED.supports, groups: [{ middle: [MIDDLE], supports: [{ ...aggregate, ...extra }] }] } }).success).toBe(false);
  });

  it.each(['confidence', 'score', 'url', 'elementId', 'derivation', 'evidence'])('has no field %s', (field) => {
    expect(derivedEdgeDetailSchema.safeParse({ ...DERIVED, [field]: 1 }).success).toBe(false);
  });

  it('refuses a group with no support or no middle entity, and a count that is not the number of groups', () => {
    expect(derivedEdgeDetailSchema.safeParse({ ...DERIVED, supports: { ...DERIVED.supports, groups: [{ middle: [MIDDLE], supports: [] }] } }).success).toBe(false);
    expect(derivedEdgeDetailSchema.safeParse({ ...DERIVED, supports: { ...DERIVED.supports, groups: [{ middle: [], supports: [aggregate] }] } }).success).toBe(false);
    expect(derivedEdgeDetailSchema.safeParse({ ...DERIVED, supports: { ...DERIVED.supports, count: { ...DERIVED.supports.count, value: 2 } } }).success).toBe(false);
  });

  it('takes a lower bound for a count and refuses an estimate or an unknown count', () => {
    expect(derivedEdgeDetailSchema.safeParse({ ...DERIVED, supports: { ...DERIVED.supports, count: { value: 1, quality: 'lowerBound', scope: 'derived:supports' } } }).success).toBe(true);
    expect(derivedEdgeDetailSchema.safeParse({ ...DERIVED, supports: { ...DERIVED.supports, count: { value: 1, quality: 'estimated', scope: 'x' } } }).success).toBe(false);
    expect(derivedEdgeDetailSchema.safeParse({ ...DERIVED, supports: { ...DERIVED.supports, count: { quality: 'unknown', scope: 'x' } } }).success).toBe(false);
  });
});
