import { describe, expect, it } from 'vitest';
import { errorBodySchema } from './error-codes.js';
import { CONFLICT_ENTRIES, INVALID_REQUEST_ENTRIES } from './error-table.js';
import { PATTERN_LIMITS } from './pattern.js';
import { savedPatternSchema, savePatternRequestSchema } from './saved-pattern.js';

const definition = { anchorType: 'a', steps: [] };
const base = { sourceId: 's', kind: 'definition', name: 'A pattern', definition };

describe('the request to save a pattern', () => {
  it('accepts a definition and a preset run, each with an optional held starting entity', () => {
    expect(savePatternRequestSchema.safeParse(base).success).toBe(true);
    expect(savePatternRequestSchema.safeParse({ ...base, anchor: { entityType: 'a', stableId: 'x' } }).success).toBe(true);
    expect(savePatternRequestSchema.safeParse({ sourceId: 's', kind: 'preset-run', name: 'n', presetId: 'p', params: {} }).success).toBe(true);
  });

  it.each([
    ['an unknown key', { ...base, extra: 1 }],
    ['a definition on a preset run', { sourceId: 's', kind: 'preset-run', name: 'n', presetId: 'p', params: {}, definition }],
    ['an unknown kind', { ...base, kind: 'text' }],
    ['a name of spaces', { ...base, name: '   ' }],
    ['a name over the limit', { ...base, name: 'x'.repeat(PATTERN_LIMITS.nameLength + 1) }],
    ['a name with a NUL', { ...base, name: 'a\u0000b' }],
    ['no source', { kind: 'definition', name: 'n', definition }],
  ])('refuses %s', (_label, body) => {
    expect(savePatternRequestSchema.safeParse(body).success).toBe(false);
  });

  it('counts a name in code points, trimmed', () => {
    expect(savePatternRequestSchema.safeParse({ ...base, name: `  ${'\u{1F600}'.repeat(PATTERN_LIMITS.nameLength)}  ` }).success).toBe(true);
    expect(savePatternRequestSchema.safeParse({ ...base, name: '\u{1F600}'.repeat(PATTERN_LIMITS.nameLength + 1) }).success).toBe(false);
  });
});

describe('a saved pattern', () => {
  const common = { id: '0192f000-0000-7000-8000-000000000001', sourceId: 's', name: 'n', askForStartingEntity: true, anchor: null, visibility: 'private', lastRunAt: null, createdAt: '2026-11-12T10:00:00.000Z', updatedAt: '2026-11-12T10:00:00.000Z', version: 1 };

  it('is a definition or a preset run, never both', () => {
    expect(savedPatternSchema.safeParse({ ...common, kind: 'definition', definition }).success).toBe(true);
    expect(savedPatternSchema.safeParse({ ...common, kind: 'preset-run', presetId: 'p', templateId: 't', templateVersion: 1, params: {} }).success).toBe(true);
    expect(savedPatternSchema.safeParse({ ...common, kind: 'definition', definition, params: {} }).success).toBe(false);
    expect(savedPatternSchema.safeParse({ ...common, kind: 'preset-run', definition, presetId: 'p', templateId: 't', templateVersion: 1, params: {} }).success).toBe(false);
  });
});

describe('the reasons of a refused save', () => {
  it('pattern-name-taken is a reason of CONFLICT with its own sentence, and a CONFLICT with no reason keeps the entry of changed elsewhere', () => {
    const entry = CONFLICT_ENTRIES['pattern-name-taken'];
    expect(entry.message).not.toMatch(/\d/);
    const body = { error: { code: 'CONFLICT', ...entry, traceId: 'trace', details: { reason: 'pattern-name-taken' } } };
    expect(errorBodySchema.safeParse(body).success).toBe(true);
    expect(errorBodySchema.safeParse({ error: { ...body.error, code: 'NOT_FOUND', message: 'Not found.', retryable: false } }).success).toBe(false);
  });

  it.each(['pattern-limit', 'pattern-personal-condition'] as const)('%s is a reason of INVALID_REQUEST with its own sentence and no number', (reason) => {
    const entry = INVALID_REQUEST_ENTRIES[reason];
    expect(entry.message).not.toMatch(/\d/);
    const body = { error: { code: 'INVALID_REQUEST', ...entry, traceId: 'trace', details: { reason } } };
    expect(errorBodySchema.safeParse(body).success).toBe(true);
    expect(errorBodySchema.safeParse({ error: { ...body.error, code: 'NOT_FOUND', message: 'Not found.', retryable: false } }).success).toBe(false);
  });
});
