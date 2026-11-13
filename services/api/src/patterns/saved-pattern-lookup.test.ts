import { describe, expect, it } from 'vitest';
import type { NewPattern, PatternRow } from '../db/patterns-repository.js';
import type { Principal } from '../seams/seams.js';
import { memoryPatterns } from '../testing/memory-patterns.js';
import { DEFINITION, recordingAudit } from '../testing/saved-pattern-rig.js';

const person = (id: string): Principal => ({ id, displayName: id, role: 'administrator' });
const OWNER = person('0192f000-0000-7000-8000-000000000001');
const OTHER = person('0192f000-0000-7000-8000-000000000002');
const draft: NewPattern = { sourceId: 'demo', name: 'p', kind: 'definition', presetId: null, templateId: null, templateVersion: null, params: null, definition: DEFINITION, anchor: null };

async function stored() {
  const patterns = memoryPatterns();
  const audit = recordingAudit();
  const saved = await patterns.savePattern(draft, { principal: OWNER, traceId: 't', audit: audit.sink });
  if (saved.outcome !== 'saved') throw new Error('not saved');
  const share = (): void => void patterns.patternRows.splice(patterns.patternRows.findIndex((row) => row.id === saved.row.id), 1, { ...saved.row, visibility: 'shared' });
  return { patterns, audit, row: saved.row, share };
}

describe('the pattern a person may run', () => {
  it('is their own live pattern, and is not another person’s private pattern, a deleted one, an unknown id or an id that is not a uuid', async () => {
    const { patterns, audit, row } = await stored();
    expect((await patterns.readRunnablePattern(row.id, OWNER.id))?.id).toBe(row.id);
    expect(await patterns.readRunnablePattern(row.id, OTHER.id)).toBeUndefined();
    expect(await patterns.readRunnablePattern('0192f000-0000-7000-8000-0000000000ff', OWNER.id)).toBeUndefined();
    expect(await patterns.readRunnablePattern('not-a-uuid', OWNER.id)).toBeUndefined();
    await patterns.deletePattern({ id: row.id, ownerId: OWNER.id, expectedVersion: 1, retentionDays: 30 }, { principal: OWNER, traceId: 't', audit: audit.sink });
    expect(await patterns.readRunnablePattern(row.id, OWNER.id)).toBeUndefined();
  });

  it('is a shared pattern for a person who does not own it, and the row says who the owner is', async () => {
    const { patterns, row, share } = await stored();
    share();
    const found = await patterns.readRunnablePattern(row.id, OTHER.id);
    expect(found).toMatchObject({ id: row.id, ownerId: OWNER.id, visibility: 'shared' });
  });
});

describe('the run of a pattern is recorded for its owner only', () => {
  const before = (row: PatternRow) => JSON.stringify({ ...row, lastRunAt: null });

  it('sets the time of the last run, and changes neither the version, the time of the last edit nor the events, so an edit from another tab still matches', async () => {
    const { patterns, row } = await stored();
    expect(row.lastRunAt).toBeNull();
    expect(await patterns.recordPatternRun(row.id, OWNER.id)).toBe(true);
    const after = await patterns.readPattern(row.id, OWNER.id);
    expect(after?.lastRunAt).not.toBeNull();
    expect(JSON.stringify({ ...after, lastRunAt: null })).toBe(before(row));
    expect(patterns.patternEvents).toHaveLength(1);
  });

  it('writes nothing for another person, a deleted pattern or an unknown id', async () => {
    const { patterns, audit, row, share } = await stored();
    share();
    const shared = JSON.stringify(await patterns.readPattern(row.id, OWNER.id));
    expect(await patterns.recordPatternRun(row.id, OTHER.id)).toBe(false);
    expect(JSON.stringify(await patterns.readPattern(row.id, OWNER.id))).toBe(shared);
    expect(await patterns.recordPatternRun('0192f000-0000-7000-8000-0000000000ff', OWNER.id)).toBe(false);
    await patterns.deletePattern({ id: row.id, ownerId: OWNER.id, expectedVersion: 1, retentionDays: 30 }, { principal: OWNER, traceId: 't', audit: audit.sink });
    expect(await patterns.recordPatternRun(row.id, OWNER.id)).toBe(false);
  });

  it('is set by the owner’s call of a shared pattern, and by that call only', async () => {
    const { patterns, row, share } = await stored();
    share();
    await patterns.recordPatternRun(row.id, OTHER.id);
    expect((await patterns.readRunnablePattern(row.id, OWNER.id))?.lastRunAt).toBeNull();
    await patterns.recordPatternRun(row.id, OWNER.id);
    expect((await patterns.readRunnablePattern(row.id, OWNER.id))?.lastRunAt).not.toBeNull();
  });
});
