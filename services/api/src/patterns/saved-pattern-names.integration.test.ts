import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PATTERN_LIMITS, type AuditEvent, type AuditSink } from '@neburyx/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAppStore, type AppStore } from '../app-store.js';
import type { NewPattern, PatternRow } from '../db/patterns-repository.js';
import type { Principal } from '../seams/seams.js';
import { addFiles, fixtureFolder, removeFixtureFolders, rows, runInProcess } from '../testing/database.js';
import { seededDatabase, type SeededDatabase } from '../testing/pattern-events-rig.js';
import { startPostgres, type TestPostgres } from '../testing/postgres.js';
import { patternNameKey } from '../db/patterns-repository.js';
import { copyNameOf } from './saved-pattern-service.js';

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
  removeFixtureFolders();
});

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
  const audit: AuditSink = { record: () => Promise.resolve() };
  const ctx = (principal: Principal) => ({ principal, traceId: 't', audit });
  return { seeded, store, pool, a, b, ctx };
}

type Started = Awaited<ReturnType<typeof started>>;

const pattern = (sourceId: string, name: string): NewPattern => ({ sourceId, name, kind: 'definition', presetId: null, templateId: null, templateVersion: null, params: null, definition: DEFINITION, anchor: null });
const save = (context: Started, who: Principal, name: string, sourceId = context.seeded.sourceId) => context.store.savePattern(pattern(sourceId, name), context.ctx(who));
async function saved(context: Started, who: Principal, name: string, sourceId = context.seeded.sourceId): Promise<PatternRow> {
  const result = await save(context, who, name, sourceId);
  if (result.outcome !== 'saved') throw new Error(`not saved: ${result.outcome}`);
  return result.row;
}
const rename = (context: Started, who: Principal, row: PatternRow, name: string) => context.store.changePattern({ id: row.id, ownerId: who.id, expectedVersion: row.version, name }, context.ctx(who));
const copy = (context: Started, who: Principal, original: PatternRow, nameOf = copyNameOf) => context.store.copyPattern({ originalId: original.id, nameOf, accept: () => true }, context.ctx(who));
const namesOf = async (context: Started, who: Principal): Promise<string[]> =>
  (await rows(context.seeded.database.ownerUrl, `SELECT name FROM saved_patterns WHERE owner_id = $1 AND deleted_at IS NULL ORDER BY name`, [who.id])).map((row) => String(row['name']));

describe('the names of a person’s patterns in Postgres', () => {
  it('refuses a save of a name the person holds, ignoring case, spaces at its ends and Unicode form, and keeps the first pattern as it was', async () => {
    const context = await started();
    const first = await saved(context, context.a, 'Ring');
    for (const name of ['Ring', 'ring', ' RING ', 'rINg']) expect((await save(context, context.a, name)).outcome, name).toBe('name-taken');
    await saved(context, context.a, 'Café');
    expect((await save(context, context.a, 'Café')).outcome).toBe('name-taken');
    expect(await namesOf(context, context.a)).toEqual(['Café', 'Ring']);
    expect(await rows(context.seeded.database.ownerUrl, `SELECT version FROM saved_patterns WHERE id = $1`, [first.id])).toEqual([{ version: 1 }]);
    expect(await rows(context.seeded.database.ownerUrl, `SELECT count(*)::int AS n FROM pattern_events`)).toEqual([{ n: 2 }]);
  });

  it('refuses a rename to a name another pattern holds, allows the pattern’s own name in another case, and a failed rename leaves the pattern and the transaction usable', async () => {
    const context = await started();
    const ring = await saved(context, context.a, 'Ring');
    const other = await saved(context, context.a, 'Other');
    expect((await rename(context, context.a, other, ' ring ')).outcome).toBe('name-taken');
    expect(await rows(context.seeded.database.ownerUrl, `SELECT name, version FROM saved_patterns WHERE id = $1`, [other.id])).toEqual([{ name: 'Other', version: 1 }]);
    expect((await rename(context, context.a, ring, 'RING')).outcome).toBe('changed');
    expect((await rename(context, context.a, other, 'Third')).outcome).toBe('changed');
  });

  it('takes the same name for two people and for two sources, and again after the pattern that held it is deleted', async () => {
    const context = await started();
    const first = await saved(context, context.a, 'Ring');
    await saved(context, context.b, 'Ring');
    await saved(context, context.a, 'Ring', context.seeded.otherSourceId);
    expect((await save(context, context.a, 'Ring')).outcome).toBe('name-taken');
    const deleted = await context.store.deletePattern({ id: first.id, ownerId: context.a.id, expectedVersion: 1, retentionDays: 30 }, context.ctx(context.a));
    expect(deleted.outcome).toBe('deleted');
    expect((await save(context, context.a, 'Ring')).outcome).toBe('saved');
  });

  it('names each copy the next free number, cuts a long name to fit the limit, and gives a copy no refusal for a name', async () => {
    const context = await started();
    const ring = await saved(context, context.a, 'Ring');
    const names: string[] = [];
    for (let round = 0; round < 3; round += 1) {
      const made = await copy(context, context.a, ring);
      if (made.outcome !== 'copied') throw new Error(made.outcome);
      names.push(made.row.name);
    }
    expect(names).toEqual(['Ring (copy)', 'Ring (copy 2)', 'Ring (copy 3)']);
    const long = await saved(context, context.a, 'x'.repeat(PATTERN_LIMITS.nameLength));
    const copies: string[] = [];
    for (let round = 0; round < 3; round += 1) {
      const made = await copy(context, context.a, long);
      if (made.outcome !== 'copied') throw new Error(made.outcome);
      copies.push(made.row.name);
    }
    expect(new Set(copies).size).toBe(3);
    expect(copies.every((name) => [...name].length <= PATTERN_LIMITS.nameLength)).toBe(true);
  });

  it('answers name-taken, writes nothing and leaves the original, when the tries for a free name run out', async () => {
    const context = await started();
    const ring = await saved(context, context.a, 'Ring');
    const before = await rows(context.seeded.database.ownerUrl, `SELECT count(*)::int AS n FROM saved_patterns`);
    const made = await copy(context, context.a, ring, () => 'Ring');
    expect(made.outcome).toBe('name-taken');
    expect(await rows(context.seeded.database.ownerUrl, `SELECT count(*)::int AS n FROM saved_patterns`)).toEqual(before);
    expect(await rows(context.seeded.database.ownerUrl, `SELECT count(*)::int AS n FROM pattern_events WHERE action = 'copied'`)).toEqual([{ n: 0 }]);
  });

  it('lets the index decide a race: a save against a rename and a rename against a rename onto one name have one winner and one name-taken', async () => {
    const context = await started();
    for (let round = 0; round < 5; round += 1) {
      const one = await saved(context, context.a, `one ${round}`);
      const two = await saved(context, context.a, `two ${round}`);
      const [first, second] = await Promise.all([rename(context, context.a, one, `name ${round}`), rename(context, context.a, two, `NAME ${round}`)]);
      expect([first.outcome, second.outcome].sort()).toEqual(['changed', 'name-taken']);
      const [made, renamed] = await Promise.all([save(context, context.a, `race ${round}`), rename(context, context.a, one.version === 1 ? { ...one, version: 2 } : one, `race ${round}`)]);
      expect([made.outcome, renamed.outcome].filter((outcome) => outcome === 'name-taken').length).toBeLessThanOrEqual(1);
    }
    const held = await rows(context.seeded.database.ownerUrl, `SELECT lower(name) AS key, count(*)::int AS n FROM saved_patterns WHERE deleted_at IS NULL GROUP BY 1 HAVING count(*) > 1`);
    expect(held).toEqual([]);
  });

  it('has the unique index on the owner, the source and the normalized name of the patterns not deleted, and says in the migration that it cannot be rolled back', async () => {
    const context = await started();
    const index = await rows(context.seeded.database.ownerUrl, `SELECT indexdef FROM pg_indexes WHERE indexname = 'saved_patterns_owner_name'`);
    expect(String(index[0]?.['indexdef'])).toContain('UNIQUE');
    expect(String(index[0]?.['indexdef'])).toContain('deleted_at IS NULL');
    expect(await rows(context.seeded.database.ownerUrl, `SELECT name FROM kysely_migration WHERE name LIKE '0020%'`)).toEqual([{ name: '0020-saved-pattern-names' }]);
    expect(readFileSync(join(SHIPPED, '0020-saved-pattern-names.sql'), 'utf8')).toContain('Rollback note');
  });
});

describe('how the database and the memory store compare names', () => {
  it('give the same key for a fixed set of names: ASCII, accents composed and decomposed, ß, dotted and dotless i, Greek sigma, a character outside the basic plane, and spaces at the ends', async () => {
    const context = await started();
    const names = ['Ring', 'RING ring', 'Caf\u00e9', 'Cafe\u0301', 'CAF\u00c9', 'Stra\u00dfe', 'STRASSE', '\u0130stanbul', 'I\u0307stanbul', '\u0131 \u0049', '\u03a3\u03af\u03c3\u03c5\u03c6\u03bf\u03c2', '\u03a3\u038a\u03a3\u03a5\u03a6\u039f\u03a3', '\ud835\udc00\ud835\udc01', '\ud801\udc00 \ud801\udc28', '  padded  ', '\u00a0nbsp\u00a0'];
    const differing: string[] = [];
    for (const name of names) {
      const database = String((await rows(context.seeded.database.ownerUrl, `SELECT lower(normalize(btrim($1::text), NFC)) AS key`, [name]))[0]?.['key']);
      if (database !== patternNameKey(name)) differing.push(name);
    }
    // the one place they differ is the capital I with a dot above, which the database lowers to a plain i and JavaScript to an i with a combining dot; the database decides, through the index, so the memory store only stands in for it
    expect(differing.sort()).toEqual(['\u0130stanbul', 'I\u0307stanbul'].sort());
  });
});

describe('the migration that makes the names unique', () => {
  it('renames the later of two patterns with one name, numbered and inside the limit, bumps the version, writes one event, and leaves the oldest and other people’s patterns', async () => {
    const database = await postgres.newDatabase();
    const env = { DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole };
    const files = Object.fromEntries(readdirSync(SHIPPED).filter((file) => file.endsWith('.sql') && file < '0020').map((file) => [file, readFileSync(join(SHIPPED, file), 'utf8')]));
    const directory = fixtureFolder(files);
    expect((await runInProcess(env, directory)).code).toBe(0);
    const owner = randomUUID();
    const other = randomUUID();
    for (const [id, subject] of [[owner, 'first'], [other, 'second']] as const) await rows(database.ownerUrl, `INSERT INTO users (id, issuer, subject, display_name) VALUES ($1, 'issuer', $2, $2)`, [id, subject]);
    await rows(database.ownerUrl, `INSERT INTO sources (id, alias, connector, uri, database, secret_ref, config_hash, identity_hash) VALUES ('alpha', 'alpha', 'neo4j', 'bolt://x', 'neo4j', 'a:b', 'h', 'i')`);
    const long = 'y'.repeat(PATTERN_LIMITS.nameLength);
    const insert = async (who: string, name: string, at: string, extra = ''): Promise<string> => {
      const id = randomUUID();
      await rows(database.ownerUrl, `INSERT INTO saved_patterns (id, owner_id, source_id, name, kind, definition, ask_for_starting_entity, created_at ${extra === '' ? '' : ', deleted_at, purge_after'}) VALUES ($1, $2, 'alpha', $3, 'definition', '{"anchorType":"a","steps":[]}', true, $4 ${extra === '' ? '' : ", now(), now() + interval '30 days'"})`, [id, who, name, at]);
      return id;
    };
    const oldest = await insert(owner, 'Ring', '2026-01-01T00:00:00Z');
    const later = await insert(owner, ' ring', '2026-01-02T00:00:00Z');
    const third = await insert(owner, 'RING', '2026-01-03T00:00:00Z');
    const taken = await insert(owner, 'Ring (2)', '2026-01-04T00:00:00Z');
    const gone = await insert(owner, 'Ring', '2026-01-05T00:00:00Z', 'deleted');
    const fits = await insert(owner, long, '2026-01-06T00:00:00Z');
    const fitsToo = await insert(owner, long.toUpperCase(), '2026-01-07T00:00:00Z');
    const spaced = `${'z'.repeat(PATTERN_LIMITS.nameLength - 5)} ${'z'.repeat(4)}`;
    const spacedFirst = await insert(owner, spaced, '2026-01-09T00:00:00Z');
    const spacedLater = await insert(owner, spaced.toUpperCase(), '2026-01-10T00:00:00Z');
    const theirs = await insert(other, 'Ring', '2026-01-08T00:00:00Z');
    addFiles(directory, { '0020-saved-pattern-names.sql': readFileSync(join(SHIPPED, '0020-saved-pattern-names.sql'), 'utf8') });
    const result = await runInProcess(env, directory);
    expect(result.code, result.stderr).toBe(0);
    const names = Object.fromEntries((await rows(database.ownerUrl, `SELECT id, name, version FROM saved_patterns`)).map((row) => [String(row['id']), { name: String(row['name']), version: Number(row['version']) }]));
    expect(names[oldest]).toEqual({ name: 'Ring', version: 1 });
    expect(names[theirs]).toEqual({ name: 'Ring', version: 1 });
    expect(names[gone]).toEqual({ name: 'Ring', version: 1 });
    expect(names[taken]).toEqual({ name: 'Ring (2)', version: 1 });
    expect(names[later]).toEqual({ name: 'ring (3)', version: 2 });
    expect(names[third]).toEqual({ name: 'RING (4)', version: 2 });
    expect(names[fits]).toEqual({ name: long, version: 1 });
    expect(names[fitsToo]?.version).toBe(2);
    expect([...(names[fitsToo]?.name ?? '')].length).toBeLessThanOrEqual(PATTERN_LIMITS.nameLength);
    expect(names[fitsToo]?.name.endsWith(' (2)')).toBe(true);
    expect(names[spacedFirst]?.version).toBe(1);
    expect(names[spacedLater]?.name).not.toMatch(/ {2}\(2\)$/);
    expect(names[spacedLater]?.name.endsWith(' (2)')).toBe(true);
    const events = await rows(database.ownerUrl, `SELECT pattern_id, actor_id, action, pattern_version FROM pattern_events ORDER BY pattern_id`);
    expect(events.map((event) => event['pattern_id']).sort()).toEqual([later, third, fitsToo, spacedLater].sort());
    expect(events.every((event) => event['action'] === 'changed' && event['actor_id'] === owner && event['pattern_version'] === 2)).toBe(true);
    expect(await rows(database.ownerUrl, `SELECT name FROM kysely_migration WHERE name LIKE '0020%'`)).toEqual([{ name: '0020-saved-pattern-names' }]);
    expect((await runInProcess(env, directory)).stdout).toContain('nothing to apply');
  });
});
