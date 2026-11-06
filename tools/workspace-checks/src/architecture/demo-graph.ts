import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mayNameTarget, readImports } from './imports.js';
import { isInside, isInsideDirectory, resolveRelative } from './resolve.js';
import type { SourceFile } from './tree.js';
import type { Violation } from './violations.js';

export const DEMO_GRAPH_SCAN_ROOTS: readonly string[] = ['services', 'apps', 'packages'];

const TOOL_ZONE = 'tools/demo-graph';
const TOOL_NAME = /demo-graph/;
const TOOL_PACKAGE = /^@neburyx\/demo-graph(?:\/|$)/;
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;

export function checkDemoGraphIsolated(files: readonly SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    if (!mayNameTarget(file.text, TOOL_NAME)) continue;
    for (const ref of readImports(file.path, file.text)) {
      if (ref.form === 'reexport-binding') continue;
      const resolved = resolveRelative(file.path, ref.specifier);
      const reaches = resolved === undefined ? TOOL_PACKAGE.test(ref.specifier) : isInsideDirectory(resolved, TOOL_ZONE);
      if (reaches) {
        violations.push({ rule: 'demo-graph-isolated', file: file.path, line: ref.line, specifier: ref.specifier, reason: 'product code never imports the demo graph tool' });
      }
    }
  }
  return violations;
}

export function packagesDependingOnDemoGraph(root: string): string[] {
  const found: string[] = [];
  const visit = (relative: string): void => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'dist' && entry.name !== 'dist-ux' && entry.name !== '.git' && !isInside(path, TOOL_ZONE)) visit(path);
      } else if (entry.isFile() && entry.name === 'package.json') {
        const parsed: unknown = JSON.parse(readFileSync(join(root, path), 'utf8'));
        const names = DEPENDENCY_FIELDS.flatMap((field) => {
          const group: unknown = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, field) : undefined;
          return typeof group === 'object' && group !== null ? Object.keys(group) : [];
        });
        if (names.some((name) => TOOL_PACKAGE.test(name))) found.push(path);
      }
    }
  };
  visit('');
  return found;
}
