import { describe, expect, it } from 'vitest';
import { HEAVY_CONTINUE_LIMIT, LINKED_HOPS_MAX, MIN_SHARED_MAX, WINDOW_MAX_DAYS, linkedEntitiesParamsSchema, sharedAttributeParamsSchema, templateRunHeavySchema, templateRunNoticeSchema, templateRunRequestSchema, templateRunResponseSchema, windowSchema } from './template-run.js';

describe('the window of a template run', () => {
  it.each([[{ days: 14 }], [{ days: 1 }], [{ days: WINDOW_MAX_DAYS }], [{ from: '2026-01-01', to: '2026-01-31' }], [{ from: '2026-01-01', to: '2026-01-01' }], [{ from: '2024-02-29', to: '2024-03-01' }]])('accepts %j', (window) => {
    expect(windowSchema.safeParse(window).success).toBe(true);
  });

  it.each([
    ['nothing', {}],
    ['no days', { days: 0 }],
    ['days one over the bound', { days: WINDOW_MAX_DAYS + 1 }],
    ['days that are not whole', { days: 1.5 }],
    ['both forms', { days: 1, from: '2026-01-01', to: '2026-01-02' }],
    ['a range in the wrong order', { from: '2026-01-31', to: '2026-01-01' }],
    ['a range one day over the bound', { from: '2026-01-01', to: '2036-01-01' }],
    ['a date that is not on the calendar', { from: '2026-02-30', to: '2026-03-01' }],
    ['a date with a time', { from: '2026-01-01T00:00:00Z', to: '2026-01-02' }],
    ['a field that is not named', { days: 1, other: true }],
  ])('refuses %s', (_name, window) => {
    expect(windowSchema.safeParse(window).success).toBe(false);
  });
});

describe('the parameters of the shared-attribute template', () => {
  const ref = { entityType: 'maker', stableId: 'A-1' };

  it('accepts the anchor alone, and every optional parameter', () => {
    expect(sharedAttributeParamsSchema.safeParse({ ref }).success).toBe(true);
    expect(sharedAttributeParamsSchema.safeParse({ ref, attributeType: 'tool', via: 'USES_TOOL', window: { days: 30 }, minShared: MIN_SHARED_MAX, limit: 10 }).success).toBe(true);
  });

  it.each([[{ minShared: 0 }], [{ minShared: MIN_SHARED_MAX + 1 }], [{ minShared: 1.5 }], [{ limit: 0 }], [{ attributeType: ['tool'] }], [{ attributeType: '' }], [{ cypher: 'MATCH (n) RETURN n' }]])('refuses %j', (extra) => {
    expect(sharedAttributeParamsSchema.safeParse({ ref, ...extra }).success).toBe(false);
  });
});

describe('the parameters of the linked-entities template', () => {
  const ref = { entityType: 'maker', stableId: 'A-1' };

  it('accepts the anchor alone, and every optional parameter', () => {
    expect(linkedEntitiesParamsSchema.safeParse({ ref }).success).toBe(true);
    expect(linkedEntitiesParamsSchema.safeParse({ ref, targetType: 'maker', via: ['LINKS', 'OWNS'], direction: 'both', maxHops: LINKED_HOPS_MAX, window: { days: 30 }, limit: 10 }).success).toBe(true);
  });

  it.each([[{ via: [] }], [{ via: 'LINKS' }], [{ via: [''] }], [{ direction: 'up' }], [{ maxHops: 0 }], [{ maxHops: LINKED_HOPS_MAX + 1 }], [{ maxHops: 1.5 }], [{ limit: 0 }], [{ targetType: '' }], [{ cypher: 'MATCH (n) RETURN n' }]])('refuses %j', (extra) => {
    expect(linkedEntitiesParamsSchema.safeParse({ ref, ...extra }).success).toBe(false);
  });
});

describe('the request and the answer of a template run', () => {
  it('takes the source, a parameter object and an optional mask, and nothing else', () => {
    expect(templateRunRequestSchema.safeParse({ sourceId: 's', params: { a: 1 }, mask: true }).success).toBe(true);
    expect(templateRunRequestSchema.safeParse({ sourceId: 's' }).success).toBe(false);
    expect(templateRunRequestSchema.safeParse({ sourceId: 's', params: {}, extra: 1 }).success).toBe(false);
  });

  it('carries a notice of each code with no payload, and refuses another code', () => {
    for (const code of ['stopListSkipped', 'noStopList', 'undatedExcluded', 'readBounded', 'evidenceCut']) expect(templateRunNoticeSchema.safeParse({ code }).success).toBe(true);
    expect(templateRunNoticeSchema.safeParse({ code: 'other' }).success).toBe(false);
    expect(templateRunNoticeSchema.safeParse({ code: 'noStopList', extra: 1 }).success).toBe(false);
  });

  it('carries the window notice with its relationship types and the supernode notice with its entities, and refuses either without its payload', () => {
    expect(templateRunNoticeSchema.safeParse({ code: 'windowNotApplied', relationshipTypes: ['LINKS'] }).success).toBe(true);
    expect(templateRunNoticeSchema.safeParse({ code: 'supernodesSkipped', entities: [{ sourceId: 's', entityType: 'maker', stableId: 'H-1' }] }).success).toBe(true);
    expect(templateRunNoticeSchema.safeParse({ code: 'windowNotApplied' }).success).toBe(false);
    expect(templateRunNoticeSchema.safeParse({ code: 'supernodesSkipped', entities: [{ entityType: 'maker' }] }).success).toBe(false);
  });

  it('carries, for a linked-entities run, how each match was reached, and accepts a run without it', () => {
    const base = { status: 'ok', templateId: 'linked-entities', templateVersion: '1', matchIds: [], nodes: [], edges: [], notices: [], warnings: [], count: { value: 0, quality: 'exact', scope: 'template:linked-entities' } };
    const match = { sourceId: 's', entityType: 'maker', stableId: 'O-1' };
    expect(templateRunResponseSchema.safeParse(base).success).toBe(true);
    expect(templateRunResponseSchema.safeParse({ ...base, links: [{ match, hops: 2, through: { ...match, stableId: 'M-1' } }, { match, hops: 1 }] }).success).toBe(true);
    expect(templateRunResponseSchema.safeParse({ ...base, links: [{ match, hops: 3 }] }).success).toBe(false);
  });

  it('accepts every quality of a count, the quality unknown included, although the shared-attribute template never produces it', () => {
    const base = { status: 'ok', templateId: 'shared-attribute', templateVersion: '1', matchIds: [], nodes: [], edges: [], notices: [], warnings: [] };
    expect(templateRunResponseSchema.safeParse({ ...base, count: { quality: 'unknown', scope: 'template:shared-attribute' } }).success).toBe(true);
    expect(templateRunResponseSchema.safeParse({ ...base, count: { value: 2, quality: 'lowerBound', scope: 'template:shared-attribute' } }).success).toBe(true);
    expect(templateRunResponseSchema.safeParse({ ...base, status: 'heavy', count: { value: 2, quality: 'exact', scope: 's' } }).success).toBe(false);
  });

  describe('the stop of a heavy run', () => {
    const heavy = { status: 'heavy', templateId: 'shared-attribute', templateVersion: '1', estimate: { value: 500, quality: 'lowerBound', scope: 'template:shared-attribute:estimate' }, threshold: 500, continueLimit: 25, notices: [], warnings: [] };

    it('is a second member of the answer, told apart by its status, and holds no rows', () => {
      expect(templateRunResponseSchema.safeParse(heavy).success).toBe(true);
      expect(templateRunHeavySchema.safeParse({ ...heavy, matchIds: [] }).success).toBe(false);
      expect(templateRunHeavySchema.safeParse({ ...heavy, nodes: [] }).success).toBe(false);
    });

    it('holds a lower bound at the threshold: no other quality, no other value', () => {
      for (const estimate of [{ value: 500, quality: 'exact', scope: 's' }, { value: 500, quality: 'estimated', scope: 's' }, { quality: 'unknown', scope: 's' }, { value: 499, quality: 'lowerBound', scope: 's' }]) {
        expect(templateRunHeavySchema.safeParse({ ...heavy, estimate }).success, JSON.stringify(estimate)).toBe(false);
      }
    });

    it('offers a page of at most 25, the one value of the product, and a threshold of at least 1', () => {
      expect(HEAVY_CONTINUE_LIMIT).toBe(25);
      expect(templateRunHeavySchema.safeParse({ ...heavy, continueLimit: 26 }).success).toBe(false);
      expect(templateRunHeavySchema.safeParse({ ...heavy, continueLimit: 7 }).success).toBe(true);
      expect(templateRunHeavySchema.safeParse({ ...heavy, threshold: 0, estimate: { value: 0, quality: 'lowerBound', scope: 's' } }).success).toBe(false);
    });

    it('takes the continue flag as a boolean on the request and nothing else new', () => {
      const request = { sourceId: 's', params: {} };
      expect(templateRunRequestSchema.safeParse({ ...request, continue: true }).success).toBe(true);
      expect(templateRunRequestSchema.safeParse({ ...request, continue: 'yes' }).success).toBe(false);
      expect(templateRunRequestSchema.safeParse({ ...request, again: true }).success).toBe(false);
    });
  });
});
