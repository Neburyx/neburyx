import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const seamsDirectory = dirname(fileURLToPath(import.meta.url));
const enterpriseRoot = resolve(seamsDirectory, '../../../../ee');
const IMPORT_SPECIFIER = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;
const ENTERPRISE_PACKAGE = /^(@[^/]+\/)?ee(\/|$)/;

function specifiersIn(source: string): string[] {
  return [...source.matchAll(IMPORT_SPECIFIER)].map((match) => match[1] ?? '');
}

function enterpriseImports(source: string, fromDirectory: string): string[] {
  return specifiersIn(source).filter((specifier) => {
    if (specifier.startsWith('.')) {
      const fromRoot = relative(enterpriseRoot, resolve(fromDirectory, specifier));
      return !fromRoot.startsWith('..');
    }
    return ENTERPRISE_PACKAGE.test(specifier);
  });
}

describe('the import check', () => {
  it.each([
    "import { x } from '../../../../ee/policy/index.js';",
    "import { x } from 'ee/policy';",
    "import { x } from '@neburyx/ee';",
    "const x = await import('../../../../ee/audit/index.js');",
  ])('flags %s', (line) => {
    expect(enterpriseImports(line, seamsDirectory)).toHaveLength(1);
  });

  it.each([
    "import type { MeResponse } from '@neburyx/contracts';",
    "import { x } from './seams.js';",
    "import { join } from 'node:path';",
    "import { x } from '../app.js';",
  ])('does not flag %s', (line) => {
    expect(enterpriseImports(line, seamsDirectory)).toEqual([]);
  });
});

describe('the seam files', () => {
  const files = readdirSync(seamsDirectory).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));

  it('are found', () => {
    expect(files).toEqual(expect.arrayContaining(['seams.ts', 'community-seams.ts']));
  });

  it.each(files)('%s imports nothing from ee/', (name) => {
    expect(enterpriseImports(readFileSync(join(seamsDirectory, name), 'utf8'), seamsDirectory)).toEqual([]);
  });
});
