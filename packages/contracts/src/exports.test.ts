import { describe, expect, it } from 'vitest';
import { exportFileSchema, exportRequestSchema, exportSchema, IDEMPOTENCY_KEY_PATTERN } from './exports.js';
import { errorBodySchema } from './error-codes.js';

const ref = { sourceId: 'demo', entityType: 'widget', stableId: 'W-1' };

describe('the export contract', () => {
  it('takes references only, with every list optional, and refuses a field it does not know', () => {
    expect(exportRequestSchema.parse({ kind: 'view', format: 'json' })).toEqual({ kind: 'view', format: 'json', entities: [], edges: [], aggregates: [], derived: [] });
    expect(exportRequestSchema.safeParse({ kind: 'view', format: 'csv', entities: [ref] }).success).toBe(true);
    for (const bad of [{ kind: 'view', format: 'png' }, { kind: 'table-csv', format: 'json' }, { kind: 'view', format: 'json', mask: true }, { format: 'json' }]) expect(exportRequestSchema.safeParse(bad).success).toBe(false);
  });

  it('accepts 16 to 64 letters, digits, underscore and hyphen as a key', () => {
    for (const ok of ['a'.repeat(16), 'a'.repeat(64), '0192f000-0000-7000-8000-000000000001']) expect(IDEMPOTENCY_KEY_PATTERN.test(ok)).toBe(true);
    for (const bad of ['a'.repeat(15), 'a'.repeat(65), 'has space 123456789', 'dots.are.not.ok.12345']) expect(IDEMPOTENCY_KEY_PATTERN.test(bad)).toBe(false);
  });

  it('shows an export without its storage key or hash', () => {
    const record = { id: '0192f000-0000-7000-8000-000000000001', status: 'ready', format: 'json', filename: 'neburyx-export-20261110T101500Z.json', sizeBytes: 12, createdAt: '2026-11-10T10:15:00.000Z', expiresAt: '2026-11-17T10:15:00.000Z' };
    expect(exportSchema.parse(record)).toEqual(record);
    expect(exportSchema.safeParse({ ...record, storageKey: 'x' }).success).toBe(false);
    expect(exportSchema.safeParse({ ...record, sha256: 'x' }).success).toBe(false);
  });

  it('requires the header first, five lines at least, and the masking as off or a count', () => {
    const header = { source: 'demo', exported: '2026-11-10T10:15:00.000Z', scope: 'current view (partial)', coverage: { shown: 0, notRetrieved: { value: 0, quality: 'exact', scope: 'not yet retrieved' }, uncounted: 0 }, masking: 'off', lines: ['a', 'b', 'c', 'd', 'e'] };
    expect(exportFileSchema.safeParse({ header, entities: [], relationships: [] }).success).toBe(true);
    expect(exportFileSchema.safeParse({ header: { ...header, lines: ['a'] }, entities: [], relationships: [] }).success).toBe(false);
    expect(exportFileSchema.safeParse({ header: { ...header, masking: { maskedFields: 3 } }, entities: [], relationships: [] }).success).toBe(true);
    expect(exportFileSchema.safeParse({ header: { ...header, scope: 'whole graph' }, entities: [], relationships: [] }).success).toBe(false);
  });

  it('lets an error body carry the new reasons only on their own codes', () => {
    const body = (code: string, details: unknown) => errorBodySchema.safeParse({ error: { code, message: 'm', retryable: false, traceId: 't', details } }).success;
    expect(body('ACCESS_DENIED', { reason: 'access-changed' })).toBe(true);
    expect(body('ACCESS_DENIED', { reason: 'export-source-changed' })).toBe(true);
    expect(body('ACCESS_DENIED', { reason: 'ai-preview-off' })).toBe(true);
    expect(body('CONFLICT', { reason: 'ai-preview-off' })).toBe(false);
    expect(body('CONFLICT', { reason: 'access-changed' })).toBe(false);
    expect(body('CONFLICT', { reason: 'export-source-changed' })).toBe(false);
    expect(body('INVALID_REQUEST', { reason: 'export-too-large', maxEntities: 300, maxRelationships: 300, maxAggregates: 100, exceeded: 'entities' })).toBe(true);
    expect(body('INVALID_REQUEST', { maxEntities: 300 })).toBe(false);
    expect(body('INVALID_REQUEST', { reason: 'export-too-large', maxEntities: 300, maxRelationships: 300, maxAggregates: 100, exceeded: 'bytes' })).toBe(false);
    expect(body('NOT_FOUND', { reason: 'export-too-large' })).toBe(false);
  });
});
