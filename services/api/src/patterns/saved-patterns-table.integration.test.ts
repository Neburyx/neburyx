import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PATTERN_LIMITS } from '@neburyx/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../testing/cli.js';
import { attempt, rows } from '../testing/database.js';
import { seededDatabase } from '../testing/pattern-events-rig.js';
import { startPostgres, type TestPostgres } from '../testing/postgres.js';

const MIGRATION = fileURLToPath(new URL('../../migrations/0018-saved-patterns.sql', import.meta.url));

let postgres: TestPostgres;

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(async () => {
  await postgres.stop();
});

const INSERT = `INSERT INTO saved_patterns (id, owner_id, source_id, name, kind, preset_id, template_id, template_version, params, definition, ask_for_starting_entity, anchor_entity_type, anchor_stable_id, deleted_at, purge_after, visibility)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`;

interface Row {
  readonly name?: string;
  readonly kind?: string;
  readonly presetId?: string | null;
  readonly templateId?: string | null;
  readonly templateVersion?: number | null;
  readonly params?: object | null;
  readonly definition?: object | null;
  readonly ask?: boolean;
  readonly anchorType?: string | null;
  readonly anchorId?: string | null;
  readonly deletedAt?: string | null;
  readonly purgeAfter?: string | null;
  readonly visibility?: string;
}

const DEFINITION = { anchorType: 'a', steps: [] };
const json = (value: object | null): string | null => (value === null ? null : JSON.stringify(value));

function valuesOf(owner: string, source: string, row: Row = {}): unknown[] {
  const kind = row.kind ?? 'definition';
  const isDefinition = kind === 'definition';
  return [
    randomUUID(),
    owner,
    source,
    row.name ?? `a pattern ${randomUUID()}`,
    kind,
    row.presetId === undefined ? null : row.presetId,
    row.templateId === undefined ? (isDefinition ? null : 'shared-attribute') : row.templateId,
    row.templateVersion === undefined ? (isDefinition ? null : 1) : row.templateVersion,
    json(row.params === undefined ? (isDefinition ? null : {}) : row.params),
    json(row.definition === undefined ? (isDefinition ? DEFINITION : null) : row.definition),
    row.ask ?? true,
    row.anchorType ?? null,
    row.anchorId ?? null,
    row.deletedAt ?? null,
    row.purgeAfter ?? null,
    row.visibility ?? 'private',
  ];
}

describe('the saved patterns table', () => {
  it('applies with the migration, and a second run has nothing to apply', async () => {
    const { database } = await seededDatabase(postgres);
    const again = await runCli(['migrate'], { DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole }).done;
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('nothing to apply');
    expect(await rows(database.ownerUrl, `SELECT name FROM kysely_migration WHERE name LIKE '0018%'`)).toEqual([{ name: '0018-saved-patterns' }]);
  });

  it('accepts both shapes and refuses a row that is half of each', async () => {
    const { database, sourceId, actorId } = await seededDatabase(postgres);
    expect(await attempt(database.appUrl, INSERT, valuesOf(actorId, sourceId))).toBe('allowed');
    expect(await attempt(database.appUrl, INSERT, valuesOf(actorId, sourceId, { kind: 'preset-run', presetId: 'p' }))).toBe('allowed');
    for (const half of [{ templateId: 'x' }, { templateVersion: 1 }, { params: {} }, { presetId: 'p' }] as const) {
      expect(await attempt(database.appUrl, INSERT, valuesOf(actorId, sourceId, half))).toContain('saved_patterns_one_shape');
    }
    for (const half of [{ definition: DEFINITION }, { templateId: null }, { templateVersion: null }, { params: null }] as const) {
      expect(await attempt(database.appUrl, INSERT, valuesOf(actorId, sourceId, { kind: 'preset-run', ...half }))).toContain('saved_patterns_one_shape');
    }
  });

  it('refuses a name of 0 or 101 characters, an unknown kind or visibility, a disagreeing anchor and a half deletion', async () => {
    const { database, sourceId, actorId } = await seededDatabase(postgres);
    expect(await attempt(database.appUrl, INSERT, valuesOf(actorId, sourceId, { name: 'x'.repeat(PATTERN_LIMITS.nameLength) }))).toBe('allowed');
    expect(await attempt(database.appUrl, INSERT, valuesOf(actorId, sourceId, { name: '' }))).toContain('saved_patterns_name_length');
    expect(await attempt(database.appUrl, INSERT, valuesOf(actorId, sourceId, { name: 'x'.repeat(PATTERN_LIMITS.nameLength + 1) }))).toContain('saved_patterns_name_length');
    expect(await attempt(database.appUrl, INSERT, valuesOf(actorId, sourceId, { kind: 'text' }))).toContain('saved_patterns_kind_known');
    expect(await attempt(database.appUrl, INSERT, valuesOf(actorId, sourceId, { visibility: 'team' }))).toContain('saved_patterns_visibility_known');
    expect(await attempt(database.appUrl, INSERT, valuesOf(actorId, sourceId, { ask: false }))).toContain('saved_patterns_ask_matches_anchor');
    expect(await attempt(database.appUrl, INSERT, valuesOf(actorId, sourceId, { ask: true, anchorType: 'a', anchorId: 'b' }))).toContain('saved_patterns_ask_matches_anchor');
    expect(await attempt(database.appUrl, INSERT, valuesOf(actorId, sourceId, { ask: false, anchorType: 'a', anchorId: 'b' }))).toBe('allowed');
    expect(await attempt(database.appUrl, INSERT, valuesOf(actorId, sourceId, { ask: false, anchorType: 'a' }))).toContain('saved_patterns_anchor_whole');
    expect(await attempt(database.appUrl, INSERT, valuesOf(actorId, sourceId, { deletedAt: '2026-01-01T00:00:00Z' }))).toContain('saved_patterns_deletion_whole');
    expect(await attempt(database.appUrl, INSERT, valuesOf(actorId, sourceId, { purgeAfter: '2026-01-01T00:00:00Z' }))).toContain('saved_patterns_deletion_whole');
    expect(await attempt(database.appUrl, INSERT, valuesOf(actorId, sourceId, { deletedAt: '2026-01-01T00:00:00Z', purgeAfter: '2026-02-01T00:00:00Z' }))).toBe('allowed');
  });

  it('has only definition and params as jsonb columns, no column for query text, and keys on the source and the owner', async () => {
    const { database, sourceId, actorId } = await seededDatabase(postgres);
    const columns = await rows(database.ownerUrl, `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'saved_patterns'`);
    expect(columns.filter((column) => column['data_type'] === 'jsonb').map((column) => column['column_name']).sort()).toEqual(['definition', 'params']);
    expect(columns.map((column) => String(column['column_name'])).filter((name) => /query|cypher|text|statement/.test(name))).toEqual([]);
    expect(await attempt(database.appUrl, INSERT, valuesOf(actorId, 'nowhere'))).toContain('foreign key');
    expect(await attempt(database.appUrl, INSERT, valuesOf(randomUUID(), sourceId))).toContain('foreign key');
  });

  it('keeps the name limit of the check equal to the limit of the contracts, and carries a rollback note', async () => {
    const { database } = await seededDatabase(postgres);
    const check = await rows(database.ownerUrl, `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = 'saved_patterns_name_length'`);
    expect(String(check[0]?.['definition'])).toContain(`<= ${PATTERN_LIMITS.nameLength}`);
    const text = readFileSync(MIGRATION, 'utf8');
    expect(text).toContain('Rollback note');
    expect(text).toContain('forward-only');
  });
});
