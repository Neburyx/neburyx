import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sourceFolder = fileURLToPath(new URL('.', import.meta.url));
const packageFolder = join(sourceFolder, '..');

const importsTestingSupport = (text: string): boolean => /from\s+['"][^'"]*\/testing\/|import\(\s*['"][^'"]*\/testing\/|from\s+['"]\.\/testing\//.test(text);

function productionFilesOutsideTesting(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) return entry.name === 'testing' ? [] : productionFilesOutsideTesting(path);
    return entry.name.endsWith('.ts') && !entry.name.includes('.test.') ? [path] : [];
  });
}

describe('the test support of the package', () => {
  it('is not built: the build configuration excludes src/testing', () => {
    expect(readFileSync(join(packageFolder, 'tsconfig.build.json'), 'utf8')).toContain('"src/testing/**"');
  });

  it('is not exported from the main entry', () => {
    const index = readFileSync(join(sourceFolder, 'index.ts'), 'utf8');
    expect(importsTestingSupport(index)).toBe(false);
    for (const name of ['createFixtureProvider', 'CONFORMANCE_CASES', 'createRecorder', 'checkRecording', 'writeRecording']) expect(index).not.toContain(name);
  });

  it('is imported by no production file', () => {
    const offenders = productionFilesOutsideTesting(sourceFolder).filter((file) => importsTestingSupport(readFileSync(file, 'utf8')));
    expect(offenders.map((file) => relative(sourceFolder, file))).toEqual([]);
  });

  it('notices an import of it, by a static import, a re-export and a dynamic import', () => {
    expect(importsTestingSupport("import { createFixtureProvider } from './testing/fixture.js';")).toBe(true);
    expect(importsTestingSupport("export * from './testing/fixture.js';")).toBe(true);
    expect(importsTestingSupport("const m = await import('./testing/fixture.js');")).toBe(true);
    expect(importsTestingSupport("import { x } from './prompts.js';")).toBe(false);
  });
});
