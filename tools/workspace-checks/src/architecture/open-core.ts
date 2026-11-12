import { mayNameTarget, readImports } from './imports.js';
import { isInside, resolveRelative } from './resolve.js';
import type { SourceFile } from './tree.js';
import type { Violation } from './violations.js';

export const OPEN_CORE_SCAN_ROOTS: readonly string[] = ['services', 'packages', 'apps', 'tools', 'deploy'];

const EE_FOLDER = 'ee';
const EE_PACKAGE = /^@neburyx\/ee-/;
/** The files that compose a run: each registers the enterprise code for Community code to load when the preview is on, the image's entry script and the one of `pnpm dev`. */
export const ENTRY_SCRIPTS: readonly string[] = ['deploy/docker/entrypoint.mjs', 'tools/dev/entry/enterprise-entry.mjs'];
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const TESTING_ZONE = 'services/api/src/testing';

/** A specifier that reaches `ee/` holds the folder name or the package prefix unless an escape spells it; a file with neither is not parsed. */
const NAMES_EE = /\bee\b|@neburyx\/ee-/;

function isExempt(path: string): boolean {
  return ENTRY_SCRIPTS.includes(path) || TEST_FILE.test(path) || isInside(path, TESTING_ZONE);
}

function reachesEe(file: string, specifier: string): boolean {
  if (EE_PACKAGE.test(specifier)) return true;
  const resolved = resolveRelative(file, specifier);
  return resolved !== undefined && isInside(resolved.path, EE_FOLDER);
}

export function checkOpenCore(files: readonly SourceFile[], read: typeof readImports = readImports): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    if (isExempt(file.path) || isInside(file.path, EE_FOLDER) || !mayNameTarget(file.text, NAMES_EE)) continue;
    for (const ref of read(file.path, file.text)) {
      if (reachesEe(file.path, ref.specifier)) {
        violations.push({ rule: 'open-core', file: file.path, line: ref.line, specifier: ref.specifier, reason: 'Community code never imports from ee/' });
      }
    }
  }
  return violations;
}
