import { describe, expect, it } from 'vitest';
import { isStaleDatabase, isStaleObject, isTestDatabase, namesFor, STALE_AFTER_MS } from './names.js';

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

describe('the names of what a run creates on the shared server', () => {
  it('match nothing that is on the dev server: the databases, logins and roles the server has by default and the ones named for other work', () => {
    const everyOther = ['neo4j', 'system', 'imdb', 'nbxprivcheck', 'nbxtest', 'nbx-test', 'nbx_test'];
    for (const name of everyOther) {
      expect(isTestDatabase(name)).toBe(false);
      expect(isStaleDatabase(name, NOW + 10 * 365 * 24 * HOUR)).toBe(false);
      expect(isStaleObject(name, NOW + 10 * 365 * 24 * HOUR)).toBe(false);
    }
  });

  it('has the prefixes and a time, and the same name never twice', () => {
    const first = namesFor(NOW);
    const second = namesFor(NOW);
    expect(first.database).toMatch(/^nbx-test-[0-9a-z]+-[0-9a-f]{6}$/);
    expect(first.login('reader')).toMatch(/^nbx_test_[0-9a-z]+_[0-9a-f]{6}_reader$/);
    expect(first.role('writer')).toMatch(/^nbx_test_[0-9a-z]+_[0-9a-f]{6}_writer_role$/);
    expect(first.database).not.toBe(second.database);
  });

  it('is recognised as stale only after the limit, and only when named exactly so', () => {
    const old = namesFor(NOW - STALE_AFTER_MS - HOUR);
    const recent = namesFor(NOW - HOUR);
    expect(isStaleDatabase(old.database, NOW)).toBe(true);
    expect(isStaleObject(old.login('reader'), NOW)).toBe(true);
    expect(isStaleObject(old.role('writer'), NOW)).toBe(true);
    expect(isStaleDatabase(recent.database, NOW)).toBe(false);
    expect(isStaleObject(recent.login('writer'), NOW)).toBe(false);
  });

  it.each(['neo4j', 'system', 'imdb', 'nbxprivcheck', 'nbx-test-', 'nbx-test-abc', 'nbx-test-1-abcdef-extra', 'my-nbx-test-1-abcdef', 'NBX-TEST-1-abcdef'])('never takes %s for a database of a run', (name) => {
    expect(isStaleDatabase(name, NOW + 10 * 365 * 24 * HOUR)).toBe(false);
    expect(isTestDatabase(name)).toBe(false);
  });

  it.each(['neo4j', 'reader', 'admin', 'editor', 'publisher', 'architect', 'PUBLIC', 'nbx_test_', 'nbx_test_x', 'nbx_test_1_abcdef_admin', 'someone_nbx_test_1_abcdef_reader'])('never takes %s for a login or role of a run', (name) => {
    expect(isStaleObject(name, NOW + 10 * 365 * 24 * HOUR)).toBe(false);
  });
});
