import { describe, expect, it } from 'vitest';
import { MIN_SHARED_MAX, WINDOW_MAX_DAYS, sharedAttributeParamsSchema, templateRunNoticeSchema, templateRunRequestSchema, templateRunResponseSchema, windowSchema } from './template-run.js';

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

  it('accepts every quality of a count, the quality unknown included, although the shared-attribute template never produces it', () => {
    const base = { status: 'ok', templateId: 'shared-attribute', templateVersion: '1', matchIds: [], nodes: [], edges: [], notices: [], warnings: [] };
    expect(templateRunResponseSchema.safeParse({ ...base, count: { quality: 'unknown', scope: 'template:shared-attribute' } }).success).toBe(true);
    expect(templateRunResponseSchema.safeParse({ ...base, count: { value: 2, quality: 'lowerBound', scope: 'template:shared-attribute' } }).success).toBe(true);
    expect(templateRunResponseSchema.safeParse({ ...base, status: 'heavy', count: { value: 2, quality: 'exact', scope: 's' } }).success).toBe(false);
  });
});
