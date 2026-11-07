import { describe, expect, it } from 'vitest';
import { degreePreviewRequestSchema, degreePreviewSchema } from './degree-preview.js';

const ref = { sourceId: 'demo', entityType: 'widget', stableId: 'W-1' };
const exact = (value: number, scope = 'degree:out:LINKS') => ({ value, quality: 'exact', scope });
const preview = {
  ref,
  total: exact(3, 'degree:total:mapped-relationship-ends'),
  byType: [{ relationshipType: 'LINKS', direction: 'out', count: exact(3), neighborTypes: ['gadget'] }],
  byNeighborType: [{ entityType: 'gadget', count: exact(3, 'degree:neighbor:gadget') }],
  warnings: [],
};

describe('the degree preview request', () => {
  it('takes a source, a node and optionally the mask flag', () => {
    expect(degreePreviewRequestSchema.safeParse({ sourceId: 'demo', ref: { entityType: 'widget', stableId: 'W-1' } }).success).toBe(true);
    expect(degreePreviewRequestSchema.safeParse({ sourceId: 'demo', ref: { entityType: 'widget', stableId: 'W-1' }, mask: true }).success).toBe(true);
  });

  it.each([
    ['an unknown field', { sourceId: 'demo', ref: { entityType: 'widget', stableId: 'W-1' }, cap: 5 }],
    ['an unknown field in the node', { sourceId: 'demo', ref: { entityType: 'widget', stableId: 'W-1', sourceId: 'demo' } }],
    ['an empty source', { sourceId: '', ref: { entityType: 'widget', stableId: 'W-1' } }],
    ['an empty entity type', { sourceId: 'demo', ref: { entityType: '', stableId: 'W-1' } }],
    ['an empty stable ID', { sourceId: 'demo', ref: { entityType: 'widget', stableId: '' } }],
    ['a reference longer than the largest token', { sourceId: 'demo', ref: { entityType: 'widget', stableId: 'x'.repeat(266_692) } }],
    ['no node', { sourceId: 'demo' }],
  ])('refuses %s', (_name, body) => {
    expect(degreePreviewRequestSchema.safeParse(body).success).toBe(false);
  });

  it('counts a stable ID of 200 characters, each a code point, as within the limit', () => {
    expect(degreePreviewRequestSchema.safeParse({ sourceId: 'demo', ref: { entityType: 'widget', stableId: '😀'.repeat(200) } }).success).toBe(true);
  });
});

describe('the degree preview response', () => {
  it('parses a preview whose every number is a count with its quality', () => {
    expect(degreePreviewSchema.safeParse(preview).success).toBe(true);
    expect(degreePreviewSchema.safeParse({ ...preview, warnings: [{ code: 'counts-capped', relationshipType: 'LINKS', reason: 'Counts are capped for this entity type' }] }).success).toBe(true);
  });

  it.each([
    ['an exact count with no value', { ...preview, total: { quality: 'exact', scope: 'x' } }],
    ['an unknown count with a value', { ...preview, total: { value: 3, quality: 'unknown', scope: 'x' } }],
    ['a bare number for a count', { ...preview, total: 3 }],
    ['a direction that is not out or in', { ...preview, byType: [{ ...preview.byType[0], direction: 'both' }] }],
    ['a pair with no neighbor type', { ...preview, byType: [{ ...preview.byType[0], neighborTypes: [] }] }],
    ['a warning code that is not named', { ...preview, warnings: [{ code: 'other', reason: 'x' }] }],
    ['a field the schema does not name', { ...preview, extra: 1 }],
  ])('refuses %s', (_name, body) => {
    expect(degreePreviewSchema.safeParse(body).success).toBe(false);
  });
});
