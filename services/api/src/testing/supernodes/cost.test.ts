import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DB_HIT_CAUSE } from '../benchmark/db-hit-cause.js';
import { RECORD_VARIABLE, serializeCostRecord, writeCostRecord, type CostRecord } from './cost.js';

const record: CostRecord = {
  neo4j: { version: '5.26.32', edition: 'enterprise' },
  commit: 'abc1234',
  date: '2026-11-08',
  dbHitCause: DB_HIT_CAUSE,
  pages: [
    { size: 1_000, readSet: 'dated', position: 'first', ms: 12.345, edges: 25, bytes: 9_000, dbHits: 782_191 },
    { size: 1_000, readSet: 'dated', position: '50%', ms: 9, edges: 25, bytes: 9_100 },
  ],
};

describe('the record of the cost of each page', () => {
  it('gives the same text for the same data', () => {
    expect(serializeCostRecord(record)).toBe(serializeCostRecord({ ...record, pages: [...record.pages] }));
  });

  it('leaves the db hits out of a page that was not profiled, and does not write a zero', () => {
    const [profiled, plain] = (JSON.parse(serializeCostRecord(record)) as { pages: Record<string, unknown>[] }).pages;
    expect(profiled).toMatchObject({ dbHits: 782_191 });
    expect(plain).not.toHaveProperty('dbHits');
  });

  it('holds the server version, edition, commit, date and what is known of the extra db hits of a first page', () => {
    expect(JSON.parse(serializeCostRecord(record))).toMatchObject({ neo4j: { version: '5.26.32', edition: 'enterprise' }, commit: 'abc1234', date: '2026-11-08', dbHitCause: { checked: true, series: '5.26' } });
  });

  it('writes to the file the variable names, and writes nothing when it is not set', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'nbx-cost-')), 'nested', 'record.json');
    expect(writeCostRecord(record, {})).toBeUndefined();
    expect(writeCostRecord(record, { [RECORD_VARIABLE]: '' })).toBeUndefined();
    expect(existsSync(path)).toBe(false);
    expect(writeCostRecord(record, { [RECORD_VARIABLE]: path })).toBe(path);
    expect(readFileSync(path, 'utf8')).toBe(serializeCostRecord(record));
  });
});
