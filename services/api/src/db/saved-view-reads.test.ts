import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { savedViewStatements, unfilteredViewReads } from '../testing/saved-view-reads.js';

const DIRECTORY = fileURLToPath(new URL('.', import.meta.url));

describe('every read of the named views leaves a deleted view out', () => {
  it('fails a statement that has only the investigation\'s deleted_at predicate', () => {
    const statement = `SELECT v.id FROM saved_views v JOIN investigations i ON i.id = v.investigation_id WHERE v.kind = 'named' AND i.deleted_at IS NULL`;
    expect(unfilteredViewReads(statement)).toEqual(['v']);
  });

  it('fails a join of the views that carries the predicate for another alias only', () => {
    const statement = `SELECT 1 FROM saved_views draft LEFT JOIN saved_views named ON named.id = draft.based_on_view_id WHERE draft.kind = 'draft' AND draft.deleted_at IS NULL`;
    expect(unfilteredViewReads(statement)).toEqual(['named']);
  });

  it('fails a read of the views with no alias and no predicate, and passes the same read with its own predicate', () => {
    expect(unfilteredViewReads(`SELECT count(*) FROM saved_views WHERE investigation_id = $1 AND kind = 'named'`)).toEqual(['saved_views']);
    expect(unfilteredViewReads(`SELECT count(*) FROM saved_views WHERE investigation_id = $1 AND kind = 'named' AND deleted_at IS NULL`)).toEqual([]);
  });

  it('passes a draft read, a read with the view\'s own predicate in the join condition, and ignores writes', () => {
    expect(unfilteredViewReads(`SELECT 1 FROM saved_views draft WHERE draft.kind = 'draft'`)).toEqual([]);
    expect(unfilteredViewReads(`SELECT 1 FROM saved_views draft LEFT JOIN saved_views named ON named.id = draft.based_on_view_id AND named.deleted_at IS NULL WHERE draft.kind = 'draft'`)).toEqual([]);
    expect(unfilteredViewReads(`UPDATE saved_views SET notes = $2 WHERE id = $1`)).toEqual([]);
    expect(unfilteredViewReads(`INSERT INTO saved_views (id) VALUES ($1)`)).toEqual([]);
  });

  it('holds for every statement in services/api/src/db', () => {
    const files = readdirSync(DIRECTORY).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));
    const failures = files.flatMap((name) => savedViewStatements(readFileSync(join(DIRECTORY, name), 'utf8')).flatMap((statement) => unfilteredViewReads(statement).map((alias) => `${name}: ${alias} in ${statement.trim().slice(0, 80).replace(/\s+/g, ' ')}`)));
    const statements = files.flatMap((name) => savedViewStatements(readFileSync(join(DIRECTORY, name), 'utf8')));
    expect(statements.length).toBeGreaterThan(15);
    expect(failures).toEqual([]);
  });
});
