import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = fileURLToPath(new URL('.', import.meta.url));
const dataFolder = join(here, '..', '..', 'data', 'thread');
const publicFiles = [...readdirSync(here).map((name) => join(here, name)), ...readdirSync(dataFolder).map((name) => join(dataFolder, name))];

/** What must not appear in the public tool: a roadmap identifier, the private manifest's anchor and a figure of the trial. */
const PRIVATE = [/\bEP-\d+(\.\d+)*\b/u, /\bB-\d{3}\b/u, /70:100428660/u, /amldemo/iu, /deepagents-trial/iu, /\b39 of 48\b/u];

describe('the public thread tool', () => {
  it('names no private roadmap identifier, anchor or trial figure in its code, fixtures or example (this file lists them and is skipped)', () => {
    for (const file of publicFiles.filter((path) => !path.endsWith('thread-public.test.ts'))) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of PRIVATE) expect(text, `${file} matches ${String(pattern)}`).not.toMatch(pattern);
    }
  });
});
