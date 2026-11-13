import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

const filesOf = (folder: string): string[] =>
  readdirSync(join(here, folder)).filter((name) => /\.tsx?$/.test(name)).map((name) => join(here, folder, name));

/** The files a source file imports from this feature's own folders, as paths under `patterns/` (static and dynamic imports). */
function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const found: string[] = [];
  for (const match of text.matchAll(/(?:from|import\()\s*'(\.[^']*)'/g)) {
    const target = relative(here, resolve(dirname(file), (match[1] ?? '').replace(/\.js$/, '')));
    found.push(target);
  }
  return found;
}

/** The editing lane's folder may not reach into the run lane's or the saved list's; the run lane reaches into the editor only through the draft model and the seam. */
describe('the direction of imports between the editor, the run and the saved list', () => {
  it('builder/ imports nothing from run/ or saved/', () => {
    const offenders = filesOf('builder').flatMap((file) => importsOf(file).filter((target) => target.startsWith('run/') || target.startsWith('saved/')).map((target) => `${relative(here, file)} -> ${target}`));
    expect(offenders).toEqual([]);
  });

  it('run/ imports only the draft model, the round trip of a definition and the seam from builder/', () => {
    const allowed = new Set(['builder/model', 'builder/from-definition', 'builder/pattern-editor']);
    const offenders = filesOf('run').flatMap((file) => importsOf(file).filter((target) => target.startsWith('builder/') && !allowed.has(target)).map((target) => `${relative(here, file)} -> ${target}`));
    expect(offenders).toEqual([]);
  });

  it('finds the files it checks', () => {
    expect(filesOf('builder').length).toBeGreaterThan(5);
    expect(filesOf('run').length).toBeGreaterThan(5);
  });
});
