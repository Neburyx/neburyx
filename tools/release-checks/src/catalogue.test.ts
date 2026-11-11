import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CHECK_IDS, releaseCatalogue } from './catalogue.js';

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

describe('releaseCatalogue', () => {
  it('lists the five checks in the fixed order', () => {
    expect(releaseCatalogue('/repo').map((check) => check.id)).toEqual([...CHECK_IDS]);
    expect(CHECK_IDS).toEqual(['fuzz', 'neutrality', 'supernode-suite', 'fuzz-real-server', 'demo-install']);
  });

  it('names every check id in the tool guide', () => {
    const guide = readFileSync(resolve(packageRoot, 'README.md'), 'utf8');
    for (const id of CHECK_IDS) expect(guide, id).toContain(`\`${id}\``);
  });
});
