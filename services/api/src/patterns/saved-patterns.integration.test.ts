import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PATTERN_LIMITS, type AuditEvent, type AuditSink } from '@neburyx/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAppStore, type AppStore } from '../app-store.js';
import type { NewPattern } from '../db/patterns-repository.js';
import { rows } from '../testing/database.js';
import { seededDatabase, type SeededDatabase } from '../testing/pattern-events-rig.js';
import { startPostgres, type TestPostgres } from '../testing/postgres.js';
import { readPatternEvents } from './pattern-events.js';

const SHIPPED = fileURLToPath(new URL('../../migrations', import.meta.url));
const DEFINITION = { anchorType: 'maker', steps: [{ relationshipTypes: ['LINKS'], direction: 'out', arrivesAt: 'maker' }] };

let postgres: TestPostgres;
const stores: AppStore[] = [];
const pools: pg.Pool[] = [];

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(async () => {
  await Promise.all(stores.map((store) => store.close()));
  await Promise.all(pools.map((pool) => pool.end()));
  await postgres.stop();
});

async function started() {
  const seeded: SeededDatabase = await seededDatabase(postgres);
  const store = createAppStore(seeded.database.appUrl, () => undefined, { migrationsDirectory: SHIPPED });
  stores.push(store);
  await store.initialize();
  const pool = new pg.Pool({ connectionString: seeded.database.appUrl });
  pools.push(pool);
  const { principal } = await store.current();
  const events: AuditEvent[] = [];
  const seen: number[] = [];
  const audit: AuditSink = {
    async record(event) {
      events.push(event);
      seen.push(Number((await pool.query('SELECT count(*)::int AS n FROM saved_patterns')).rows[0].n));
    },
  };
  return { seeded, store, pool, principal, events, seen, audit };
}

const definitionPattern = (sourceId: string, name = 'My ring'): NewPattern => ({ sourceId, name, kind: 'definition', presetId: null, templateId: null, templateVersion: null, params: null, definition: DEFINITION, anchor: null });

describe('saving a pattern in Postgres', () => {
  it('writes the structure as sent for the caller, one saved event, and calls the seam once after the commit', async () => {
    const { seeded, store, pool, principal, events, seen, audit } = await started();
    const result = await store.savePattern(definitionPattern(seeded.sourceId), { principal, traceId: 'trace-1', audit });
    if (result.outcome !== 'saved') throw new Error('not saved');
    expect(result.row).toMatchObject({ ownerId: principal.id, sourceId: seeded.sourceId, name: 'My ring', kind: 'definition', definition: DEFINITION, askForStartingEntity: true, visibility: 'private', lastRunAt: null, version: 1 });
    const stored = await rows(seeded.database.ownerUrl, `SELECT definition, params, template_id FROM saved_patterns WHERE id = $1`, [result.row.id]);
    expect(stored).toEqual([{ definition: DEFINITION, params: null, template_id: null }]);
    expect(await readPatternEvents(pool, { patternId: result.row.id })).toMatchObject([{ action: 'saved', version: 1, actorId: principal.id, sourceId: seeded.sourceId }]);
    expect(events).toMatchObject([{ action: 'pattern.save', resourceType: 'pattern', resourceRef: result.row.id, traceId: 'trace-1' }]);
    expect(seen).toEqual([1]);
  });

  it('stores a preset run with its template, version and parameters and no definition', async () => {
    const { seeded, store, principal, audit } = await started();
    const result = await store.savePattern({ sourceId: seeded.sourceId, name: 'Linked', kind: 'preset-run', presetId: 'linked-makers', templateId: 'linked-entities', templateVersion: 1, params: { maxHops: 2 }, definition: null, anchor: null }, { principal, traceId: 't', audit });
    if (result.outcome !== 'saved') throw new Error('not saved');
    expect(await rows(seeded.database.ownerUrl, `SELECT kind, preset_id, template_id, template_version, params, definition FROM saved_patterns WHERE id = $1`, [result.row.id])).toEqual([
      { kind: 'preset-run', preset_id: 'linked-makers', template_id: 'linked-entities', template_version: 1, params: { maxHops: 2 }, definition: null },
    ]);
  });

  it('holds a starting entity in the two anchor columns', async () => {
    const { seeded, store, principal, audit } = await started();
    const result = await store.savePattern({ ...definitionPattern(seeded.sourceId), anchor: { entityType: 'maker', stableId: 'm-1' } }, { principal, traceId: 't', audit });
    if (result.outcome !== 'saved') throw new Error('not saved');
    expect(result.row).toMatchObject({ askForStartingEntity: false, anchorEntityType: 'maker', anchorStableId: 'm-1' });
  });

  it('refuses the 201st pattern of the caller, and two saves sent together at 199 leave exactly 200', async () => {
    const { seeded, store, principal, audit } = await started();
    for (let index = 0; index < PATTERN_LIMITS.patternsPerSource - 1; index += 1) {
      await rows(seeded.database.ownerUrl, `INSERT INTO saved_patterns (id, owner_id, source_id, name, kind, definition, ask_for_starting_entity) VALUES ($1, $2, $3, $4, 'definition', $5, true)`, [randomUUID(), principal.id, seeded.sourceId, `p${index}`, JSON.stringify(DEFINITION)]);
    }
    const [first, second] = await Promise.all([
      store.savePattern(definitionPattern(seeded.sourceId, 'a'), { principal, traceId: 't', audit }),
      store.savePattern(definitionPattern(seeded.sourceId, 'b'), { principal, traceId: 't', audit }),
    ]);
    expect([first.outcome, second.outcome].sort()).toEqual(['limit', 'saved']);
    expect(await rows(seeded.database.ownerUrl, `SELECT count(*)::int AS n FROM saved_patterns WHERE source_id = $1`, [seeded.sourceId])).toEqual([{ n: PATTERN_LIMITS.patternsPerSource }]);
    expect((await store.savePattern(definitionPattern(seeded.sourceId, 'c'), { principal, traceId: 't', audit })).outcome).toBe('limit');
    expect(await store.savePattern(definitionPattern(seeded.otherSourceId), { principal, traceId: 't', audit })).toMatchObject({ outcome: 'saved' });
  });

  it('refuses with AUDIT_UNAVAILABLE and keeps no row and makes no seam call when the event cannot be written', async () => {
    const { seeded, store, principal, events, audit } = await started();
    await rows(seeded.database.ownerUrl, `CREATE FUNCTION refuse_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'no'; END $$`);
    await rows(seeded.database.ownerUrl, `CREATE TRIGGER refuse_event BEFORE INSERT ON pattern_events FOR EACH ROW EXECUTE FUNCTION refuse_event()`);
    const failure = await store.savePattern(definitionPattern(seeded.sourceId), { principal, traceId: 't', audit }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'AUDIT_UNAVAILABLE' });
    expect(await rows(seeded.database.ownerUrl, `SELECT count(*)::int AS n FROM saved_patterns`)).toEqual([{ n: 0 }]);
    expect(events).toEqual([]);
  });

  it('lists the caller\'s patterns of one source newest changed first in pages, and none of another person\'s', async () => {
    const { seeded, store, principal, audit } = await started();
    for (let index = 0; index < 7; index += 1) await store.savePattern(definitionPattern(seeded.sourceId, `p${index}`), { principal, traceId: 't', audit });
    await store.savePattern(definitionPattern(seeded.otherSourceId, 'other source'), { principal, traceId: 't', audit });
    const otherPerson = randomUUID();
    await rows(seeded.database.ownerUrl, `INSERT INTO users (id, issuer, subject, display_name) VALUES ($1, 'issuer', 'second', 'Second')`, [otherPerson]);
    await rows(seeded.database.ownerUrl, `INSERT INTO saved_patterns (id, owner_id, source_id, name, kind, definition, ask_for_starting_entity) VALUES ($1, $2, $3, 'theirs', 'definition', $4, true)`, [randomUUID(), otherPerson, seeded.sourceId, JSON.stringify(DEFINITION)]);
    const first = await store.listPatterns({ ownerId: principal.id, sourceId: seeded.sourceId, limit: 3, after: undefined });
    expect(first.rows.map((row) => row.name)).toEqual(['p6', 'p5', 'p4']);
    expect(first.next).toBeDefined();
    const second = await store.listPatterns({ ownerId: principal.id, sourceId: seeded.sourceId, limit: 3, after: first.next });
    expect(second.rows.map((row) => row.name)).toEqual(['p3', 'p2', 'p1']);
    const third = await store.listPatterns({ ownerId: principal.id, sourceId: seeded.sourceId, limit: 3, after: second.next });
    expect(third.rows.map((row) => row.name)).toEqual(['p0']);
    expect(third.next).toBeUndefined();
    expect((await store.listPatterns({ ownerId: otherPerson, sourceId: seeded.sourceId, limit: 10, after: undefined })).rows.map((row) => row.name)).toEqual(['theirs']);
  });

  it('changes a pattern under a lock with the version guard: one winner for two changes, a stale version writes nothing, one changed event for each change', async () => {
    const { seeded, store, pool, principal, audit } = await started();
    const saved = await store.savePattern(definitionPattern(seeded.sourceId), { principal, traceId: 't', audit });
    if (saved.outcome !== 'saved') throw new Error('not saved');
    const id = saved.row.id;
    const results = await Promise.all([
      store.changePattern({ id, ownerId: principal.id, expectedVersion: 1, name: 'a' }, { principal, traceId: 't', audit }),
      store.changePattern({ id, ownerId: principal.id, expectedVersion: 1, name: 'b' }, { principal, traceId: 't', audit }),
    ]);
    expect(results.map((result) => result.outcome).sort()).toEqual(['changed', 'conflict']);
    expect(await store.changePattern({ id, ownerId: principal.id, expectedVersion: 1, name: 'c' }, { principal, traceId: 't', audit })).toEqual({ outcome: 'conflict' });
    const held = await store.readPattern(id, principal.id);
    expect(held).toMatchObject({ version: 2 });
    expect((await readPatternEvents(pool, { patternId: id })).map((event) => [event.action, event.version])).toEqual([['saved', 1], ['changed', 2]]);
    const held2 = await store.changePattern({ id, ownerId: principal.id, expectedVersion: 2, anchor: { entityType: 'maker', stableId: 'm-1' }, definition: { ...DEFINITION, steps: [] } }, { principal, traceId: 't', audit });
    expect(held2).toMatchObject({ outcome: 'changed', row: { askForStartingEntity: false, anchorStableId: 'm-1', version: 3 } });
    const cleared = await store.changePattern({ id, ownerId: principal.id, expectedVersion: 3, anchor: null }, { principal, traceId: 't', audit });
    expect(cleared).toMatchObject({ outcome: 'changed', row: { askForStartingEntity: true, anchorEntityType: null, anchorStableId: null, version: 4 } });
  });

  it('answers not-found for another person\'s pattern and changes and deletes nothing of it', async () => {
    const { seeded, store, principal, audit } = await started();
    const saved = await store.savePattern(definitionPattern(seeded.sourceId), { principal, traceId: 't', audit });
    if (saved.outcome !== 'saved') throw new Error('not saved');
    const stranger = randomUUID();
    expect(await store.readPattern(saved.row.id, stranger)).toBeUndefined();
    expect(await store.changePattern({ id: saved.row.id, ownerId: stranger, expectedVersion: 1, name: 'x' }, { principal, traceId: 't', audit })).toEqual({ outcome: 'not-found' });
    expect(await store.deletePattern({ id: saved.row.id, ownerId: stranger, expectedVersion: 1, retentionDays: 30 }, { principal, traceId: 't', audit })).toEqual({ outcome: 'not-found' });
    expect(await store.readPattern(saved.row.id, principal.id)).toMatchObject({ name: 'My ring', version: 1 });
  });

  it('soft-deletes with the purge date the retention days on, stops listing and reading it, counts it no more towards the limit, and a second delete is not-found', async () => {
    const { seeded, store, pool, principal, audit } = await started();
    const saved = await store.savePattern(definitionPattern(seeded.sourceId), { principal, traceId: 't', audit });
    if (saved.outcome !== 'saved') throw new Error('not saved');
    const result = await store.deletePattern({ id: saved.row.id, ownerId: principal.id, expectedVersion: 1, retentionDays: 14 }, { principal, traceId: 't', audit });
    if (result.outcome !== 'deleted') throw new Error('not deleted');
    expect(Date.parse(result.purgeAfter) - Date.parse(result.deletedAt)).toBe(14 * 86_400_000);
    expect(result.row.version).toBe(2);
    expect(await store.readPattern(saved.row.id, principal.id)).toBeUndefined();
    expect((await store.listPatterns({ ownerId: principal.id, sourceId: seeded.sourceId, limit: 10, after: undefined })).rows).toEqual([]);
    expect(await store.deletePattern({ id: saved.row.id, ownerId: principal.id, expectedVersion: 2, retentionDays: 14 }, { principal, traceId: 't', audit })).toEqual({ outcome: 'not-found' });
    expect(await store.changePattern({ id: saved.row.id, ownerId: principal.id, expectedVersion: 2, name: 'x' }, { principal, traceId: 't', audit })).toEqual({ outcome: 'not-found' });
    expect((await readPatternEvents(pool, { patternId: saved.row.id })).map((event) => [event.action, event.version])).toEqual([['saved', 1], ['deleted', 2]]);
  });

  it('refuses a change and a delete with AUDIT_UNAVAILABLE and leaves the pattern as it was when the event cannot be written', async () => {
    const { seeded, store, principal, audit } = await started();
    const saved = await store.savePattern(definitionPattern(seeded.sourceId), { principal, traceId: 't', audit });
    if (saved.outcome !== 'saved') throw new Error('not saved');
    await rows(seeded.database.ownerUrl, `CREATE FUNCTION refuse_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'no'; END $$`);
    await rows(seeded.database.ownerUrl, `CREATE TRIGGER refuse_event BEFORE INSERT ON pattern_events FOR EACH ROW EXECUTE FUNCTION refuse_event()`);
    expect(await store.changePattern({ id: saved.row.id, ownerId: principal.id, expectedVersion: 1, name: 'x' }, { principal, traceId: 't', audit }).catch((error: unknown) => error)).toMatchObject({ code: 'AUDIT_UNAVAILABLE' });
    expect(await store.deletePattern({ id: saved.row.id, ownerId: principal.id, expectedVersion: 1, retentionDays: 30 }, { principal, traceId: 't', audit }).catch((error: unknown) => error)).toMatchObject({ code: 'AUDIT_UNAVAILABLE' });
    expect(await store.readPattern(saved.row.id, principal.id)).toMatchObject({ name: 'My ring', version: 1 });
  });

  it('purges a deleted pattern past its purge date and not one before it or one that is not deleted, once, while its events stay', async () => {
    const { seeded, store, pool, principal, audit } = await started();
    const save = async (name: string): Promise<string> => {
      const result = await store.savePattern(definitionPattern(seeded.sourceId, name), { principal, traceId: 't', audit });
      if (result.outcome !== 'saved') throw new Error('not saved');
      return result.row.id;
    };
    const [due, early, live] = [await save('due'), await save('early'), await save('live')];
    for (const id of [due, early]) await store.deletePattern({ id, ownerId: principal.id, expectedVersion: 1, retentionDays: 30 }, { principal, traceId: 't', audit });
    await rows(seeded.database.ownerUrl, `UPDATE saved_patterns SET purge_after = now() - interval '1 day' WHERE id = $1`, [due]);
    const purged: string[] = [];
    expect(await store.purgeExpiredPatterns(async ({ id, sourceId }) => void purged.push(`${id}@${sourceId}`))).toBe(1);
    expect(purged).toEqual([`${due}@${seeded.sourceId}`]);
    expect((await rows(seeded.database.ownerUrl, `SELECT id FROM saved_patterns ORDER BY name`)).map((row) => row['id']).sort()).toEqual([early, live].sort());
    expect(await store.purgeExpiredPatterns(async () => undefined)).toBe(0);
    expect((await readPatternEvents(pool, { patternId: due })).map((event) => event.action)).toEqual(['saved', 'deleted']);
  });

  it('runs twice at the same moment without removing a row twice or failing', async () => {
    const { seeded, store, principal, audit } = await started();
    for (let index = 0; index < 5; index += 1) {
      const saved = await store.savePattern(definitionPattern(seeded.sourceId, `p${index}`), { principal, traceId: 't', audit });
      if (saved.outcome !== 'saved') throw new Error('not saved');
      await store.deletePattern({ id: saved.row.id, ownerId: principal.id, expectedVersion: 1, retentionDays: 30 }, { principal, traceId: 't', audit });
    }
    await rows(seeded.database.ownerUrl, `UPDATE saved_patterns SET purge_after = now() - interval '1 day'`);
    const counts = await Promise.all([store.purgeExpiredPatterns(async () => undefined), store.purgeExpiredPatterns(async () => undefined)]);
    expect(counts[0] + counts[1]).toBe(5);
    expect(await rows(seeded.database.ownerUrl, `SELECT count(*)::int AS n FROM saved_patterns`)).toEqual([{ n: 0 }]);
  });

  it('keeps a pattern whose purge date has not passed and a pattern that is not deleted', async () => {
    const { seeded, store, principal, audit } = await started();
    await store.savePattern(definitionPattern(seeded.sourceId), { principal, traceId: 't', audit });
    expect(await store.purgeExpiredPatterns(async () => undefined)).toBe(0);
    expect(await rows(seeded.database.ownerUrl, `SELECT count(*)::int AS n FROM saved_patterns`)).toEqual([{ n: 1 }]);
  });
});

describe('running a pattern in Postgres', () => {
  it('finds the caller’s own pattern and a shared one, and none of another person’s private pattern, a deleted one, or an id that is not a uuid', async () => {
    const { seeded, store, principal, audit } = await started();
    const saved = await store.savePattern(definitionPattern(seeded.sourceId), { principal, traceId: 't', audit });
    if (saved.outcome !== 'saved') throw new Error('not saved');
    const otherPerson = randomUUID();
    await rows(seeded.database.ownerUrl, `INSERT INTO users (id, issuer, subject, display_name) VALUES ($1, 'issuer', 'second', 'Second')`, [otherPerson]);
    expect((await store.readRunnablePattern(saved.row.id, principal.id))?.id).toBe(saved.row.id);
    expect(await store.readRunnablePattern(saved.row.id, otherPerson)).toBeUndefined();
    await rows(seeded.database.ownerUrl, `UPDATE saved_patterns SET visibility = 'shared' WHERE id = $1`, [saved.row.id]);
    expect(await store.readRunnablePattern(saved.row.id, otherPerson)).toMatchObject({ id: saved.row.id, ownerId: principal.id, visibility: 'shared' });
    expect(await store.readRunnablePattern('not-a-uuid', principal.id)).toBeUndefined();
    expect(await store.readRunnablePattern(saved.row.id, 'not-a-uuid')).toBeUndefined();
    await rows(seeded.database.ownerUrl, `UPDATE saved_patterns SET deleted_at = now(), purge_after = now() + interval '30 days' WHERE id = $1`, [saved.row.id]);
    expect(await store.readRunnablePattern(saved.row.id, principal.id)).toBeUndefined();
  });

  it('records the owner’s run as the time of the last run only, and writes nothing for another person, a deleted pattern or an id that is not a uuid', async () => {
    const { seeded, store, pool, principal, audit } = await started();
    const saved = await store.savePattern(definitionPattern(seeded.sourceId), { principal, traceId: 't', audit });
    if (saved.outcome !== 'saved') throw new Error('not saved');
    const otherPerson = randomUUID();
    await rows(seeded.database.ownerUrl, `INSERT INTO users (id, issuer, subject, display_name) VALUES ($1, 'issuer', 'second', 'Second')`, [otherPerson]);
    await rows(seeded.database.ownerUrl, `UPDATE saved_patterns SET visibility = 'shared' WHERE id = $1`, [saved.row.id]);
    const snapshot = async () => rows(seeded.database.ownerUrl, `SELECT version, updated_at, last_run_at FROM saved_patterns WHERE id = $1`, [saved.row.id]);
    const first = await snapshot();
    expect(await store.recordPatternRun(saved.row.id, otherPerson)).toBe(false);
    expect(await snapshot()).toEqual(first);
    expect(await store.recordPatternRun('not-a-uuid', principal.id)).toBe(false);
    expect(await store.recordPatternRun(saved.row.id, principal.id)).toBe(true);
    const [after] = await snapshot();
    expect(after).toMatchObject({ version: 1, updated_at: first[0]?.updated_at });
    expect(after?.last_run_at).not.toBeNull();
    expect(await readPatternEvents(pool, { patternId: saved.row.id })).toHaveLength(1);
    await rows(seeded.database.ownerUrl, `UPDATE saved_patterns SET deleted_at = now(), purge_after = now() + interval '30 days' WHERE id = $1`, [saved.row.id]);
    expect(await store.recordPatternRun(saved.row.id, principal.id)).toBe(false);
  });
});
