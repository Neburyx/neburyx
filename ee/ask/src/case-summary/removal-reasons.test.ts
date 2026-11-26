import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { REMOVAL_REASONS } from '@neburyx/ee-ai-runtime';
import { describe, expect, it } from 'vitest';

describe('the reasons of a removed sentence', () => {
  it('are the ones the database stores: a reason it does not know would lose the record of a whole call', () => {
    const migration = readFileSync(fileURLToPath(new URL('../../../migrations/0011-summary-run-removals.sql', import.meta.url)), 'utf8');
    const stored = /reason text NOT NULL CHECK \(reason IN \(([^)]*)\)\)/u.exec(migration)?.[1]?.split(',').map((value) => value.trim().replaceAll("'", ''));
    expect(stored).toEqual([...REMOVAL_REASONS]);
  });
});
