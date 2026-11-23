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
    expect(first.database).toMatch(/^nbx-test-tn-[0-9a-z]+-[0-9a-f]{6}$/);
    expect(first.login('reader')).toMatch(/^nbx_test_tn_[0-9a-z]+_[0-9a-f]{6}_reader$/);
    expect(first.role('writer')).toMatch(/^nbx_test_tn_[0-9a-z]+_[0-9a-f]{6}_writer_role$/);
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

  it('never takes a hand-made name with the prefix for one of its own, however old it looks: the owner tag is what makes a name its own', () => {
    const forever = NOW + 10 * 365 * 24 * HOUR;
    // a hand-made login of a person or another tool, with the prefix and no tag, in the shape this module used before it had a tag, and with a tag of another owner
    for (const name of ['nbx_test_ht2318_ro', 'nbx_test_ep23a4_reader', 'nbx_test_aml_ro', 'nbx_test_1_abcdef_reader', 'nbx_test_mwtiz5si_c4acad_reader', 'nbx_test_mwtiz5si_c4acad_reader_role', 'nbx_test_xx_mwtiz5si_c4acad_reader', 'nbx_test_TN_mwtiz5si_c4acad_reader', 'nbx_test_tn_mwtiz5si_c4acad_admin']) {
      expect(isStaleObject(name, forever), name).toBe(false);
    }
    for (const name of ['nbx-test-mwtiz5si-c4acad', 'nbx-test-xx-mwtiz5si-c4acad', 'nbx-test-ht2318', 'nbx-test-TN-mwtiz5si-c4acad']) {
      expect(isStaleDatabase(name, forever), name).toBe(false);
      expect(isTestDatabase(name), name).toBe(false);
    }
  });

  it('does take a name that has the tag, the shape and an age', () => {
    const old = Date.UTC(2026, 10, 5, 3, 0, 0).toString(36);
    expect(isStaleObject(`nbx_test_tn_${old}_c4acad_reader`, NOW)).toBe(true);
    expect(isStaleObject(`nbx_test_tn_${old}_c4acad_writer_role`, NOW)).toBe(true);
    expect(isStaleDatabase(`nbx-test-tn-${old}-c4acad`, NOW)).toBe(true);
    // the same names, not yet old enough
    const fresh = (NOW - HOUR).toString(36);
    expect(isStaleObject(`nbx_test_tn_${fresh}_c4acad_reader`, NOW)).toBe(false);
  });
});
