import type { SourceFile } from './tree.js';
import type { Violation } from './violations.js';

export const PATTERN_EVENT_SCAN_ROOTS: readonly string[] = ['services', 'apps', 'packages', 'tools', 'ee'];

/** A statement that changes or removes a stored pattern event. The table is append-only: the database refuses these, and no code may even try. */
const TABLE = String.raw`(?:"?public"?\s*\.\s*)?"?pattern_events"?\b`;
const STATEMENTS: readonly { readonly pattern: RegExp; readonly label: string }[] = [
  { pattern: new RegExp(String.raw`\bUPDATE\s+(?:ONLY\s+)?${TABLE}`, 'gi'), label: 'UPDATE pattern_events' },
  { pattern: new RegExp(String.raw`\bDELETE\s+FROM\s+(?:ONLY\s+)?${TABLE}`, 'gi'), label: 'DELETE FROM pattern_events' },
  { pattern: new RegExp(String.raw`\bTRUNCATE\s+(?:TABLE\s+)?(?:ONLY\s+)?${TABLE}`, 'gi'), label: 'TRUNCATE pattern_events' },
];

/** Test files and the test support folder prove that the table refuses these statements, and this file names them to look for them. */
function isExempt(path: string): boolean {
  return /\.test\.[cm]?[jt]sx?$/.test(path) || path.startsWith('services/api/src/testing/') || path === 'tools/workspace-checks/src/architecture/pattern-events.ts';
}

export function checkPatternEvents(files: readonly SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    if (isExempt(file.path) || !/pattern_events/i.test(file.text)) continue;
    for (const { pattern, label } of STATEMENTS) {
      for (const match of file.text.matchAll(pattern)) {
        const line = file.text.slice(0, match.index).split('\n').length;
        violations.push({ rule: 'pattern-events', file: file.path, line, specifier: label, reason: 'a pattern event is never changed or removed; the table is append-only' });
      }
    }
  }
  return violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
