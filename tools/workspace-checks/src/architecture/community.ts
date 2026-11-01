import { readImports } from './imports.js';
import { isInside, isInsideDirectory, resolveRelative } from './resolve.js';
import type { SourceFile } from './tree.js';
import type { Violation } from './violations.js';

export const COMMUNITY_SCAN_ROOTS: readonly string[] = ['.'];
export const COMMUNITY_SCAN_EXCLUDES: readonly string[] = ['ee', 'tools/workspace-checks/fixtures'];

const ENTERPRISE_ZONE = 'ee';
const ENTERPRISE_PACKAGE = /^(?:@neburyx\/)?ee(?:\/|$)/;

export function checkCommunityImports(files: readonly SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    if (isInside(file.path, ENTERPRISE_ZONE)) continue;
    for (const ref of readImports(file.path, file.text)) {
      if (ref.form === 'reexport-binding') continue;
      const resolved = resolveRelative(file.path, ref.specifier);
      const reachesEnterprise = resolved === undefined ? ENTERPRISE_PACKAGE.test(ref.specifier) : isInsideDirectory(resolved, ENTERPRISE_ZONE);
      if (reachesEnterprise) {
        violations.push({
          rule: 'community-imports-ee',
          file: file.path,
          line: ref.line,
          specifier: ref.specifier,
          reason: 'Community code never imports from ee/',
        });
      }
    }
  }
  return violations;
}
