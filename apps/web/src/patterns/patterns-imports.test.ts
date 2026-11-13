import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

/** Files of one folder of `patterns/`, as paths under it; `''` is the folder itself. */
const filesOf = (folder: string): string[] => readdirSync(join(here, folder)).filter((name) => /\.tsx?$/.test(name)).map((name) => join(folder, name));

/** The files that `text`, the source of `file`, imports with a relative path (static and dynamic), as paths under `patterns/` without the extension. */
export function importsIn(file: string, text: string): string[] {
  return [...text.matchAll(/(?:from|import\()\s*'(\.[^']*)'/g)].map((match) => relative(here, resolve(here, dirname(file), (match[1] ?? '').replace(/\.js$/, ''))));
}

const importsOf = (file: string): string[] => importsIn(file, readFileSync(join(here, file), 'utf8'));

const SEAM = ['builder/model', 'builder/from-definition', 'builder/pattern-editor'];

/** What a file of `folder` imports from `builder/`, `run/` or `saved/` and may not. */
export function violations(file: string, imports: readonly string[]): string[] {
  const folder = file.includes('/') ? (file.split('/')[0] ?? '') : '';
  if (folder === 'builder') return imports.filter((target) => target.startsWith('run/') || target.startsWith('saved/')).map((target) => `${file} -> ${target}`);
  // the panel composes the lanes and takes the editor and the draft model, which the seam lists
  return imports.filter((target) => target.startsWith('builder/') && !SEAM.includes(target)).map((target) => `${file} -> ${target}`);
}

/** The editing lane's folder may not reach into the run lane's or the saved list's; every other file reaches into the editor only through the draft model, the round trip of a definition and the seam. */
describe('the direction of imports between the editor, the run and the saved list', () => {
  // this file names imports in its own cases, so it is not read
  const all = [...filesOf('builder'), ...filesOf('run'), ...filesOf('saved'), ...filesOf('')].filter((file) => file !== 'patterns-imports.test.ts');

  it('finds the files it checks', () => {
    expect(filesOf('builder').length).toBeGreaterThan(5);
    expect(filesOf('run').length).toBeGreaterThan(5);
    expect(filesOf('saved').length).toBeGreaterThan(5);
    expect(all).toContain('patterns-panel.tsx');
  });

  it('holds in every file of the editing and run lanes', () => {
    expect(all.flatMap((file) => violations(file, importsOf(file)))).toEqual([]);
  });

  it('reports an import that breaks a rule', () => {
    expect(violations('builder/x.ts', importsIn('builder/x.ts', "import { a } from '../run/run-copy.js';"))).toEqual(['builder/x.ts -> run/run-copy']);
    expect(violations('builder/x.ts', importsIn('builder/x.ts', "const m = await import('../saved/saved-copy.js');"))).toEqual(['builder/x.ts -> saved/saved-copy']);
    expect(violations('saved/x.ts', importsIn('saved/x.ts', "import { a } from '../builder/copy.js';"))).toEqual(['saved/x.ts -> builder/copy']);
    expect(violations('run/x.ts', importsIn('run/x.ts', "import type { a } from '../builder/pattern-editor.js';"))).toEqual([]);
    expect(violations('patterns-panel.tsx', importsIn('patterns-panel.tsx', "import { a } from './builder/copy.js';"))).toEqual(['patterns-panel.tsx -> builder/copy']);
  });
});
