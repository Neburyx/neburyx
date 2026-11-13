import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../testing/cli.js';
import { attempt, rows } from '../testing/database.js';
import { seededDatabase } from '../testing/pattern-events-rig.js';
import { startPostgres, type TestPostgres } from '../testing/postgres.js';

const MIGRATION = fileURLToPath(new URL('../../migrations/0017-pattern-events.sql', import.meta.url));

let postgres: TestPostgres;

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(async () => {
  await postgres.stop();
});

const INSERT = `INSERT INTO pattern_events (id, source_id, pattern_id, actor_id, action, pattern_version) VALUES ($1, $2, $3, $4, $5, $6)`;

describe('the pattern events table', () => {
  it('applies with the migration, and a second run has nothing to apply', async () => {
    const { database } = await seededDatabase(postgres);
    const again = await runCli(['migrate'], { DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole }).done;
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('nothing to apply');
    const applied = await rows(database.ownerUrl, `SELECT name FROM kysely_migration WHERE name LIKE '0017%'`);
    expect(applied).toEqual([{ name: '0017-pattern-events' }]);
  });

  it('holds exactly the seven columns, none of them able to carry a definition or a value', async () => {
    const { database } = await seededDatabase(postgres);
    const columns = await rows(database.ownerUrl, `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'pattern_events' ORDER BY ordinal_position`);
    expect(columns.map((column) => column['column_name'])).toEqual(['id', 'source_id', 'pattern_id', 'actor_id', 'action', 'pattern_version', 'created_at']);
    const types = columns.map((column) => String(column['data_type']));
    expect(types.filter((type) => ['json', 'jsonb', 'bytea', 'ARRAY'].includes(type))).toEqual([]);
    const text = columns.filter((column) => column['data_type'] === 'text').map((column) => column['column_name']);
    expect(text).toEqual(['source_id', 'action']);
    const checks = await rows(database.ownerUrl, `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'pattern_events'::regclass AND contype = 'c' AND conname = 'pattern_events_action_known'`);
    expect(String(checks[0]?.['definition'])).toContain("'saved'");
    const foreign = await rows(database.ownerUrl, `SELECT a.attname FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey) WHERE c.conrelid = 'pattern_events'::regclass AND c.contype = 'f' ORDER BY 1`);
    expect(foreign.map((row) => row['attname'])).toEqual(['actor_id', 'source_id']);
  });

  it('refuses a row with an unlisted action, a version below 1, an unknown source or an unknown actor', async () => {
    const { database, sourceId, actorId } = await seededDatabase(postgres);
    const good = [randomUUID(), sourceId, randomUUID(), actorId, 'saved', 1] as const;
    expect(await attempt(database.appUrl, INSERT, good)).toBe('allowed');
    expect(await attempt(database.appUrl, INSERT, [randomUUID(), sourceId, randomUUID(), actorId, 'Saved', 1])).toContain('pattern_events_action_known');
    expect(await attempt(database.appUrl, INSERT, [randomUUID(), sourceId, randomUUID(), actorId, 'saved', 0])).toContain('pattern_events_version_positive');
    expect(await attempt(database.appUrl, INSERT, [randomUUID(), 'nowhere', randomUUID(), actorId, 'saved', 1])).toContain('foreign key');
    expect(await attempt(database.appUrl, INSERT, [randomUUID(), sourceId, randomUUID(), randomUUID(), 'saved', 1])).toContain('foreign key');
  });

  it('lets the application role insert and read, and refuses it, and the owner, any change or removal', async () => {
    const { database, sourceId, actorId } = await seededDatabase(postgres);
    const id = randomUUID();
    expect(await attempt(database.appUrl, INSERT, [id, sourceId, randomUUID(), actorId, 'saved', 1])).toBe('allowed');
    expect(await rows(database.appUrl, `SELECT id FROM pattern_events`)).toEqual([{ id }]);
    for (const statement of [`UPDATE pattern_events SET pattern_version = 2`, `DELETE FROM pattern_events`, `TRUNCATE pattern_events`]) {
      expect(await attempt(database.appUrl, statement)).toContain('permission denied');
      expect(await attempt(database.ownerUrl, statement)).toContain('pattern events are append-only');
    }
    expect(await rows(database.ownerUrl, `SELECT id, pattern_version FROM pattern_events`)).toEqual([{ id, pattern_version: 1 }]);
  });

  it('carries a rollback note in the migration', () => {
    const text = readFileSync(MIGRATION, 'utf8');
    expect(text).toContain('Rollback note');
    expect(text).toContain('forward-only');
  });
});
