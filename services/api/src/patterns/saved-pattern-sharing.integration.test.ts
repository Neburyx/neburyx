import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PATTERN_LIMITS, type AuditEvent, type AuditSink } from '@neburyx/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAppStore, type AppStore } from '../app-store.js';
import type { NewPattern, PatternRow } from '../db/patterns-repository.js';
import type { Principal } from '../seams/seams.js';
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

/** Two people on one migrated database: A (the local user) and B. */
async function started() {
  const seeded: SeededDatabase = await seededDatabase(postgres);
  const store = createAppStore(seeded.database.appUrl, () => undefined, { migrationsDirectory: SHIPPED });
  stores.push(store);
  await store.initialize();
  const pool = new pg.Pool({ connectionString: seeded.database.appUrl });
  pools.push(pool);
  const { principal: a } = await store.current();
  const bId = randomUUID();
  await rows(seeded.database.ownerUrl, `INSERT INTO users (id, issuer, subject, display_name) VALUES ($1, 'issuer', 'second', 'Second person')`, [bId]);
  const b: Principal = { id: bId, displayName: 'Second person', role: 'investigator' };
  const events: AuditEvent[] = [];
  const audit: AuditSink = { record: (event) => (events.push(event), Promise.resolve()) };
  const ctx = (principal: Principal) => ({ principal, traceId: 't', audit });
  return { seeded, store, pool, a, b, events, audit, ctx };
}

const definitionPattern = (sourceId: string, name = 'My ring', anchor: NewPattern['anchor'] = null): NewPattern => ({ sourceId, name, kind: 'definition', presetId: null, templateId: null, templateVersion: null, params: null, definition: DEFINITION, anchor });
type Started = Awaited<ReturnType<typeof started>>;

async function saveFor(context: Started, who: Principal, over: Partial<NewPattern> = {}): Promise<PatternRow> {
  const result = await context.store.savePattern({ ...definitionPattern(context.seeded.sourceId), ...over }, context.ctx(who));
  if (result.outcome !== 'saved') throw new Error('not saved');
  return result.row;
}

const shareAs = (context: Started, who: Principal, row: PatternRow, visibility: 'shared' | 'private') =>
  context.store.changePattern({ id: row.id, ownerId: who.id, expectedVersion: row.version, visibility, action: visibility === 'shared' ? 'shared' : 'unshared' }, context.ctx(who));

describe('the shared patterns index', () => {
  it('exists with its predicate after the migration, and the migration applies once', async () => {
    const { seeded } = await started();
    const found = await rows(seeded.database.ownerUrl, `SELECT indexdef FROM pg_indexes WHERE indexname = 'saved_patterns_shared_source'`);
    expect(found).toHaveLength(1);
    const definition = String(found[0]?.['indexdef']);
    expect(definition).toContain('(source_id, updated_at DESC, id)');
    expect(definition).toContain("visibility = 'shared'");
    expect(definition).toContain('deleted_at IS NULL');
    expect(await rows(seeded.database.ownerUrl, `SELECT name FROM kysely_migration WHERE name LIKE '0019%'`)).toEqual([{ name: '0019-saved-patterns-shared-index' }]);
  });
});

describe('the shared half of the list', () => {
  it('reads through the shared index when a table scan is not an option, and orders newest changed first', async () => {
    const context = await started();
    const client = new pg.Client({ connectionString: context.seeded.database.ownerUrl });
    await client.connect();
    try {
      await client.query('SET enable_seqscan = off');
      const plan = await client.query(`EXPLAIN SELECT id FROM saved_patterns WHERE owner_id <> $1 AND visibility = 'shared' AND source_id = $2 AND deleted_at IS NULL ORDER BY updated_at DESC, id DESC LIMIT 26`, [context.b.id, context.seeded.sourceId]);
      expect(plan.rows.map((row) => String(row['QUERY PLAN'])).join('\n')).toMatch(/saved_patterns_shared_source/);
    } finally {
      await client.end();
    }
  });
});

describe('sharing in Postgres', () => {
  it('shares and unshares with the requested action recorded, and one winner for two shares with the same version', async () => {
    const context = await started();
    const row = await saveFor(context, context.a);
    const [first, second] = await Promise.all([shareAs(context, context.a, row, 'shared'), shareAs(context, context.a, row, 'shared')]);
    expect([first.outcome, second.outcome].sort()).toEqual(['changed', 'conflict']);
    const shared = first.outcome === 'changed' ? first.row : second.outcome === 'changed' ? second.row : row;
    expect(shared).toMatchObject({ visibility: 'shared', version: 2 });
    const unshared = await shareAs(context, context.a, shared, 'private');
    expect(unshared).toMatchObject({ outcome: 'changed', row: { visibility: 'private', version: 3 } });
    expect((await readPatternEvents(context.pool, { patternId: row.id })).map((event) => [event.action, event.version])).toEqual([['saved', 1], ['shared', 2], ['unshared', 3]]);
  });

  it('refuses a share with AUDIT_UNAVAILABLE and leaves the row as it was when the event cannot be written', async () => {
    const context = await started();
    const row = await saveFor(context, context.a);
    await rows(context.seeded.database.ownerUrl, `CREATE FUNCTION refuse_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'no'; END $$`);
    await rows(context.seeded.database.ownerUrl, `CREATE TRIGGER refuse_event BEFORE INSERT ON pattern_events FOR EACH ROW EXECUTE FUNCTION refuse_event()`);
    const failure = await shareAs(context, context.a, row, 'shared').catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'AUDIT_UNAVAILABLE' });
    expect(await rows(context.seeded.database.ownerUrl, `SELECT visibility, version FROM saved_patterns WHERE id = $1`, [row.id])).toEqual([{ visibility: 'private', version: 1 }]);
  });

  it('changes and deletes nothing for another person, whatever the version, even for a shared pattern', async () => {
    const context = await started();
    const row = await saveFor(context, context.a);
    const shared = await shareAs(context, context.a, row, 'shared');
    if (shared.outcome !== 'changed') throw new Error('not shared');
    expect(await context.store.changePattern({ id: row.id, ownerId: context.b.id, expectedVersion: 2, name: 'Mine' }, context.ctx(context.b))).toEqual({ outcome: 'not-found' });
    expect(await context.store.changePattern({ id: row.id, ownerId: context.b.id, expectedVersion: 2, visibility: 'private', action: 'unshared' }, context.ctx(context.b))).toEqual({ outcome: 'not-found' });
    expect(await context.store.deletePattern({ id: row.id, ownerId: context.b.id, expectedVersion: 2, retentionDays: 30 }, context.ctx(context.b))).toEqual({ outcome: 'not-found' });
    expect(await rows(context.seeded.database.ownerUrl, `SELECT name, visibility, version, deleted_at FROM saved_patterns WHERE id = $1`, [row.id])).toEqual([{ name: 'My ring', visibility: 'shared', version: 2, deleted_at: null }]);
  });

  it('reads a pattern for the person who made it and for anyone while it is shared, and for no one else', async () => {
    const context = await started();
    const row = await saveFor(context, context.a);
    expect((await context.store.readRunnablePattern(row.id, context.a.id))?.id).toBe(row.id);
    expect(await context.store.readRunnablePattern(row.id, context.b.id)).toBeUndefined();
    const shared = await shareAs(context, context.a, row, 'shared');
    if (shared.outcome !== 'changed') throw new Error('not shared');
    expect((await context.store.readRunnablePattern(row.id, context.b.id))?.id).toBe(row.id);
    await context.store.deletePattern({ id: row.id, ownerId: context.a.id, expectedVersion: 2, retentionDays: 30 }, context.ctx(context.a));
    expect(await context.store.readRunnablePattern(row.id, context.b.id)).toBeUndefined();
    expect(await context.store.readRunnablePattern(row.id, context.a.id)).toBeUndefined();
  });
});

describe('the list in Postgres with shared patterns', () => {
  it('lists a person\'s own and the shared patterns of others on one source, once each, with the creator\'s current name, newest changed first, never a private or deleted one or another source\'s', async () => {
    const context = await started();
    const ownShared = await saveFor(context, context.a, { name: 'A shared' });
    await shareAs(context, context.a, ownShared, 'shared');
    await saveFor(context, context.a, { name: 'A private' });
    await saveFor(context, context.b, { name: 'B own' });
    const gone = await saveFor(context, context.b, { name: 'B gone' });
    const goneShared = await shareAs(context, context.b, gone, 'shared');
    if (goneShared.outcome !== 'changed') throw new Error('not shared');
    await context.store.deletePattern({ id: gone.id, ownerId: context.b.id, expectedVersion: 2, retentionDays: 30 }, context.ctx(context.b));
    const elsewhere = await saveFor(context, context.a, { name: 'A elsewhere', sourceId: context.seeded.otherSourceId });
    await shareAs(context, context.a, elsewhere, 'shared');
    const forB = await context.store.listPatterns({ ownerId: context.b.id, sourceId: context.seeded.sourceId, limit: 10, after: undefined });
    expect(forB.rows.map((row) => [row.name, row.ownerName])).toEqual([['B own', 'Second person'], ['A shared', 'Local workspace']]);
    const forA = await context.store.listPatterns({ ownerId: context.a.id, sourceId: context.seeded.sourceId, limit: 10, after: undefined });
    expect(forA.rows.map((row) => row.name).sort()).toEqual(['A private', 'A shared']);
    expect(forA.rows.filter((row) => row.name === 'A shared')).toHaveLength(1);
    await rows(context.seeded.database.ownerUrl, `UPDATE users SET display_name = 'Renamed' WHERE id = $1`, [context.a.id]);
    expect((await context.store.listPatterns({ ownerId: context.b.id, sourceId: context.seeded.sourceId, limit: 10, after: undefined })).rows.find((row) => row.name === 'A shared')?.ownerName).toBe('Renamed');
  });

  it('pages both halves in one order with the next position at the last row read', async () => {
    const context = await started();
    for (let index = 0; index < 8; index += 1) {
      const row = await saveFor(context, context.a, { name: `a${index}` });
      await shareAs(context, context.a, row, 'shared');
    }
    for (let index = 0; index < 7; index += 1) await saveFor(context, context.b, { name: `b${index}` });
    const seen: string[] = [];
    let after: Awaited<ReturnType<Started['store']['listPatterns']>>['next'];
    for (let page = 0; page < 6; page += 1) {
      const found = await context.store.listPatterns({ ownerId: context.b.id, sourceId: context.seeded.sourceId, limit: 4, after });
      seen.push(...found.rows.map((row) => row.name));
      after = found.next;
      if (after === undefined) break;
    }
    expect(seen).toHaveLength(15);
    expect(new Set(seen).size).toBe(15);
  });
});

describe('copying in Postgres', () => {
  it('copies the structure and held entity into a private pattern of the caller at version 1, and writes the event of the copy and of the original', async () => {
    const context = await started();
    const original = await saveFor(context, context.a, { name: 'Ring', anchor: { entityType: 'maker', stableId: 'm-1' } });
    const shared = await shareAs(context, context.a, original, 'shared');
    if (shared.outcome !== 'changed') throw new Error('not shared');
    const result = await context.store.copyPattern({ originalId: original.id, nameOf: (name) => `${name} (copy)`, accept: () => true }, context.ctx(context.b));
    if (result.outcome !== 'copied') throw new Error('not copied');
    expect(result.row).toMatchObject({ ownerId: context.b.id, sourceId: original.sourceId, name: 'Ring (copy)', kind: 'definition', definition: DEFINITION, askForStartingEntity: false, anchorEntityType: 'maker', anchorStableId: 'm-1', visibility: 'private', version: 1, lastRunAt: null });
    expect(result.original).toMatchObject({ id: original.id, version: 2 });
    expect((await readPatternEvents(context.pool, { patternId: result.row.id })).map((event) => [event.action, event.version, event.actorId])).toEqual([['copied', 1, context.b.id]]);
    expect((await readPatternEvents(context.pool, { patternId: original.id })).map((event) => [event.action, event.version])).toEqual([['saved', 1], ['shared', 2], ['copied', 2]]);
    expect(context.events.filter((event) => event.action === 'pattern.copy')).toHaveLength(2);
  });

  it('copies nothing that the caller may not see, that was unshared or deleted, or that the check refuses', async () => {
    const context = await started();
    const original = await saveFor(context, context.a);
    const copy = (id: string, accept = true) => context.store.copyPattern({ originalId: id, nameOf: (name) => name, accept: () => accept }, context.ctx(context.b));
    expect(await copy(original.id)).toEqual({ outcome: 'not-found' });
    const shared = await shareAs(context, context.a, original, 'shared');
    if (shared.outcome !== 'changed') throw new Error('not shared');
    expect(await copy(original.id, false)).toEqual({ outcome: 'refused' });
    const unshared = await shareAs(context, context.a, shared.row, 'private');
    if (unshared.outcome !== 'changed') throw new Error('not unshared');
    expect(await copy(original.id)).toEqual({ outcome: 'not-found' });
    expect(await rows(context.seeded.database.ownerUrl, `SELECT count(*)::int AS n FROM saved_patterns WHERE owner_id = $1`, [context.b.id])).toEqual([{ n: 0 }]);
  });

  it('refuses the copy over the limit, and two copies sent together at 199 leave exactly 200', async () => {
    const context = await started();
    const original = await saveFor(context, context.a);
    await shareAs(context, context.a, original, 'shared');
    for (let index = 0; index < PATTERN_LIMITS.patternsPerSource - 1; index += 1) {
      await rows(context.seeded.database.ownerUrl, `INSERT INTO saved_patterns (id, owner_id, source_id, name, kind, definition, ask_for_starting_entity) VALUES ($1, $2, $3, $4, 'definition', $5, true)`, [randomUUID(), context.b.id, context.seeded.sourceId, `b${index}`, DEFINITION]);
    }
    const copy = () => context.store.copyPattern({ originalId: original.id, nameOf: (name) => `${name} (copy)`, accept: () => true }, context.ctx(context.b));
    const [first, second] = await Promise.all([copy(), copy()]);
    expect([first.outcome, second.outcome].sort()).toEqual(['copied', 'limit']);
    expect(await rows(context.seeded.database.ownerUrl, `SELECT count(*)::int AS n FROM saved_patterns WHERE owner_id = $1 AND source_id = $2`, [context.b.id, context.seeded.sourceId])).toEqual([{ n: PATTERN_LIMITS.patternsPerSource }]);
  });

  it('refuses with AUDIT_UNAVAILABLE and keeps no copy and no event when an event cannot be written', async () => {
    const context = await started();
    const original = await saveFor(context, context.a);
    await shareAs(context, context.a, original, 'shared');
    await rows(context.seeded.database.ownerUrl, `CREATE FUNCTION refuse_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'no'; END $$`);
    await rows(context.seeded.database.ownerUrl, `CREATE TRIGGER refuse_event BEFORE INSERT ON pattern_events FOR EACH ROW EXECUTE FUNCTION refuse_event()`);
    const failure = await context.store.copyPattern({ originalId: original.id, nameOf: (name) => name, accept: () => true }, context.ctx(context.b)).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'AUDIT_UNAVAILABLE' });
    expect(await rows(context.seeded.database.ownerUrl, `SELECT count(*)::int AS n FROM saved_patterns`)).toEqual([{ n: 1 }]);
  });
});

describe('the two-owner story in Postgres', () => {
  it('walks A\'s share, B\'s sight and copy, A\'s unshare, B\'s copy kept, and the purge of the original leaving the copy and its events', async () => {
    const context = await started();
    const original = await saveFor(context, context.a, { name: 'Ring' });
    const shared = await shareAs(context, context.a, original, 'shared');
    if (shared.outcome !== 'changed') throw new Error('not shared');
    expect((await context.store.listPatterns({ ownerId: context.b.id, sourceId: context.seeded.sourceId, limit: 10, after: undefined })).rows.map((row) => row.name)).toEqual(['Ring']);
    expect((await context.store.listPatterns({ ownerId: context.b.id, sourceId: context.seeded.otherSourceId, limit: 10, after: undefined })).rows).toEqual([]);
    const copied = await context.store.copyPattern({ originalId: original.id, nameOf: (name) => `${name} (copy)`, accept: () => true }, context.ctx(context.b));
    if (copied.outcome !== 'copied') throw new Error('not copied');
    const changed = await context.store.changePattern({ id: original.id, ownerId: context.a.id, expectedVersion: 2, name: 'Changed' }, context.ctx(context.a));
    if (changed.outcome !== 'changed') throw new Error('not changed');
    expect((await context.store.readPattern(copied.row.id, context.b.id))?.name).toBe('Ring (copy)');
    const unshared = await shareAs(context, context.a, changed.row, 'private');
    if (unshared.outcome !== 'changed') throw new Error('not unshared');
    expect((await context.store.listPatterns({ ownerId: context.b.id, sourceId: context.seeded.sourceId, limit: 10, after: undefined })).rows.map((row) => row.name)).toEqual(['Ring (copy)']);
    const deleted = await context.store.deletePattern({ id: original.id, ownerId: context.a.id, expectedVersion: 4, retentionDays: 30 }, context.ctx(context.a));
    expect(deleted.outcome).toBe('deleted');
    await rows(context.seeded.database.ownerUrl, `UPDATE saved_patterns SET purge_after = now() - interval '1 day' WHERE id = $1`, [original.id]);
    expect(await context.store.purgeExpiredPatterns(() => Promise.resolve())).toBe(1);
    expect((await context.store.readPattern(copied.row.id, context.b.id))?.name).toBe('Ring (copy)');
    expect((await readPatternEvents(context.pool, { patternId: copied.row.id })).map((event) => event.action)).toEqual(['copied']);
    expect((await readPatternEvents(context.pool, { patternId: original.id })).map((event) => event.action)).toContain('copied');
  });
});
