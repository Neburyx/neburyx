import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DB_HIT_NOTICE, renderRecord, type RunData } from './record.js';
import { renderStored } from './render-record.js';

const stored = (version: string) => ({
  date: '2026-11-07',
  neo4j: { version, edition: 'enterprise' },
  serverIsLoopback: true,
  cold: { ms: 400, failed: false },
  stopped: [],
  profiles: [],
  cells: [{ size: 100_000, readSet: 'dated', position: 'first', rows: 100_000, repeated: 0, samples: 30, failures: 0, p50: 5, p95: 10, max: 12 }],
  previews: [],
});

const directoryWith = (data: unknown): string => {
  const directory = mkdtempSync(join(tmpdir(), 'nbx-render-'));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'supernode.json'), JSON.stringify(data));
  return directory;
};

describe('rendering the stored record again', () => {
  it('adds the cause for the series of the run, says it was rendered from the stored run, and stores the cause with the data', () => {
    const directory = directoryWith(stored('5.26.32'));
    renderStored(directory);
    const text = readFileSync(join(directory, 'supernode.md'), 'utf8');
    expect(text).toContain(DB_HIT_NOTICE);
    expect(text).toContain('## Db hits of the first dated page');
    expect(text).toContain('Rendered again from the stored run of 2026-11-07, not from a new run.');
    expect(text).toContain('Affected:');
    expect((JSON.parse(readFileSync(join(directory, 'supernode.json'), 'utf8')) as RunData).dbHitCause.checked).toBe(true);
  });

  it('says the cause was not checked on a run of another series', () => {
    const directory = directoryWith(stored('2026.10.1'));
    renderStored(directory);
    const text = readFileSync(join(directory, 'supernode.md'), 'utf8');
    expect(text).toContain('has not been checked on Neo4j 2026');
    expect(text).not.toContain('Affected:');
  });

  it('renders the same text twice from the same data', () => {
    const directory = directoryWith(stored('5.26.32'));
    renderStored(directory);
    const first = readFileSync(join(directory, 'supernode.md'), 'utf8');
    renderStored(directory);
    expect(readFileSync(join(directory, 'supernode.md'), 'utf8')).toBe(first);
  });

  it('fails on data that is not a run', () => {
    expect(() => renderStored(directoryWith({ nothing: true }))).toThrow('not the data of a run');
  });

  it('cannot render a record without the cause, and names what is missing', () => {
    const { dbHitCause: _cause, ...without } = { ...(stored('5.26.32') as unknown as RunData), dbHitCause: undefined };
    expect(() => renderRecord(without as unknown as RunData)).toThrow('dbHitCause');
  });
});
