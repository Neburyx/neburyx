import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { combinePacks } from './combine.js';

const folder = mkdtempSync(join(tmpdir(), 'combine-retention-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

describe('the mapping file the demo setup writes', () => {
  it('holds sources only and sets no retention, so the defaults the README names are what a reader sees', () => {
    const out = join(folder, 'neburyx.yaml');
    combinePacks(['banking-fraud', 'insurance-claims'], out);
    const written = parse(readFileSync(out, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(written)).toEqual(['sources']);
    expect(written).not.toHaveProperty('retention');
  });
});
