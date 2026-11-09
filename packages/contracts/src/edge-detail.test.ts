import { describe, expect, it } from 'vitest';
import { edgeDetailSchema, edgeRefSegmentOf, EVIDENCE_NOT_AVAILABLE, MAX_EDGE_REF_SEGMENT, parseEdgeRefSegment } from './edge-detail.js';

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
    ['a derived reference', encode('{"sourceId":"demo","derived":{"ruleId":"R","from":{"sourceId":"demo","entityType":"a","stableId":"1"},"to":{"sourceId":"demo","entityType":"b","stableId":"2"}}}')],
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
