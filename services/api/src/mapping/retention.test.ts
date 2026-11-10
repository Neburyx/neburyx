import { stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import { baseSource, fileOf, issuesOf } from '../testing/mapping.js';
import { parseMapping } from './load.js';
import { RETENTION_DEFAULTS, retentionOf } from './retention.js';

const withRetention = (retention: unknown): string => stringify({ sources: [baseSource()], retention }, { aliasDuplicateObjects: false, blockQuote: false });

describe('the retention block of the mapping file', () => {
  it.each([
    ['0', 0],
    ['366', 366],
    ['a negative number', -1],
    ['a fraction', 1.5],
    ['a string', '30'],
  ])('refuses %s for the days of deleted investigations and names the path', (_name, value) => {
    const issues = issuesOf(withRetention({ deleted_investigations_days: value }));
    expect(issues.map((issue) => issue.path)).toContain('retention.deleted_investigations_days');
  });

  it.each([0, 366, 2.5, 'seven'])('refuses %s for the days of exports and names the path', (value) => {
    const issues = issuesOf(withRetention({ exports_days: value }));
    expect(issues.map((issue) => issue.path)).toContain('retention.exports_days');
  });

  it('refuses a key it does not know and a block that is not a map', () => {
    expect(issuesOf(withRetention({ audit_days: 90 })).map((issue) => issue.path)).toContain('retention.audit_days');
    expect(issuesOf(withRetention(30)).map((issue) => issue.path)).toContain('retention');
  });

  it('holds the defaults when there is no block', () => {
    expect(parseMapping(fileOf(baseSource()), 'neburyx.yaml').retention).toEqual({ deletedInvestigationsDays: 30, exportsDays: 7 });
  });

  it('keeps one key and defaults the other', () => {
    expect(parseMapping(withRetention({ deleted_investigations_days: 14 }), 'neburyx.yaml').retention).toEqual({ deletedInvestigationsDays: 14, exportsDays: 7 });
  });

  it('holds both keys when both are set, at the bounds', () => {
    expect(parseMapping(withRetention({ deleted_investigations_days: 1, exports_days: 365 }), 'neburyx.yaml').retention).toEqual({ deletedInvestigationsDays: 1, exportsDays: 365 });
  });

  it('does not change the hash of any source', () => {
    const plain = parseMapping(fileOf(baseSource()), 'neburyx.yaml');
    const retained = parseMapping(withRetention({ deleted_investigations_days: 14, exports_days: 30 }), 'neburyx.yaml');
    expect(retained.sources.map((source) => source.configHash)).toEqual(plain.sources.map((source) => source.configHash));
  });

  it('gives the defaults to a model that was not loaded from a file', () => {
    expect(retentionOf({ sources: [] })).toBe(RETENTION_DEFAULTS);
  });
});
