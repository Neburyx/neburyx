import { assistantReadSchema, askRunResultSchema, type AskRunResult } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { fileQueryResult, lowerBoundResult, okResult, unknownCountResult, zeroResult } from '../testing/assistant-rig.js';
import { readNotRead, readOfNothing, readOfResult, readOfView, subjectOf } from './reads.js';

const withCount = (run: AskRunResult, count: Record<string, unknown>): AskRunResult => {
  if (run.templateId !== 'shared-attribute' || run.result.status === 'heavy') throw new Error('not a shared-attribute result');
  return askRunResultSchema.parse({ ...run, result: { ...run.result, count } });
};

describe('the reads of a turn, written by the server', () => {
  it('lists a read that ran with its rows and the quality of that count, whatever the quality', () => {
    expect(readOfResult('template', 'shared-attribute', { id: 'A-1' }, okResult())).toEqual({ tool: 'shared-attribute', kind: 'template', subject: 'A-1', read: true, rows: 1, quality: 'exact', partial: false });
    expect(readOfResult('intent', 'shared', {}, withCount(okResult(), { quality: 'estimated', value: 40, scope: 'test' }))).toMatchObject({ rows: 40, quality: 'estimated' });
    expect(readOfResult('intent', 'shared', {}, lowerBoundResult())).toMatchObject({ rows: 150, quality: 'lowerBound', partial: true });
    expect(readOfResult('pattern', 'Fan-out', { anchor: 'A-1' }, fileQueryResult())).toMatchObject({ kind: 'pattern', rows: 2, quality: 'exact', subject: 'A-1' });
  });

  it('gives no number for a count that is not known', () => {
    const entry = readOfResult('intent', 'shared', { id: 'A-1' }, unknownCountResult());
    expect(entry).toMatchObject({ read: true, quality: 'unknown' });
    expect('rows' in entry).toBe(false);
    expect(assistantReadSchema.safeParse(entry).success).toBe(true);
  });

  it('lists a read that found nothing with zero rows, and a read that did not run with no subject and no number', () => {
    expect(readOfNothing('template', 'search', { entityType: 'widget', text: 'x' })).toEqual({ tool: 'search', kind: 'template', subject: 'widget, x', read: true, rows: 0, quality: 'exact', partial: false });
    expect(readNotRead('template', 'expand')).toEqual({ tool: 'expand', kind: 'template', read: false });
    expect(readOfResult('template', 'shared-attribute', {}, zeroResult())).toMatchObject({ rows: 0, quality: 'exact' });
  });

  it('lists the view reading as a read of its own, exact', () => {
    expect(readOfView(7)).toEqual({ tool: 'view', kind: 'view', read: true, rows: 7, quality: 'exact', partial: false });
  });

  it('writes the subject from the accepted values only, without the name of a saved pattern, and nothing when there is none', () => {
    expect(subjectOf({ pattern: 'p-1', anchor: 'A-1' })).toBe('A-1');
    expect(subjectOf({ a: 'A-1', b: 'A-2' })).toBe('A-1, A-2');
    expect(subjectOf({ pattern: 'p-1' })).toBeUndefined();
    expect(subjectOf({ text: 'x'.repeat(900) })?.length).toBe(400);
  });

  it('never has a number with an unknown count, or an unknown kind, quality or number below zero', () => {
    const good = { tool: 't', kind: 'template', read: true, rows: 1, quality: 'exact', partial: false };
    expect(assistantReadSchema.safeParse(good).success).toBe(true);
    for (const bad of [{ ...good, kind: 'other' }, { ...good, quality: 'sure' }, { ...good, rows: -1 }, { ...good, quality: 'unknown' }, { tool: 't', kind: 'view', read: true, quality: 'exact', partial: false }, { tool: 't', kind: 'view', read: false, subject: 'A' }]) {
      expect(assistantReadSchema.safeParse(bad).success).toBe(false);
    }
  });
});
