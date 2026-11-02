import { ADAPTER_SCAN_ROOTS } from './adapter.js';
import { readImports } from './imports.js';
import { isFileModule, isInside, resolveRelative } from './resolve.js';
import type { SourceFile } from './tree.js';
import type { Rule, Violation } from './violations.js';

export const GATE_CAPABILITY_SCAN_ROOTS: readonly string[] = ADAPTER_SCAN_ROOTS;

const API_SRC = 'services/api/src';
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

interface Capability {
  readonly rule: Extract<Rule, 'system-principal' | 'source-gate'>;
  readonly module: string;
  readonly allowedFolders: readonly string[];
  readonly allowedFiles: readonly string[];
  readonly what: string;
}

export const CAPABILITIES: readonly Capability[] = [
  { rule: 'system-principal', module: `${API_SRC}/gate/system-principal`, allowedFolders: [`${API_SRC}/gate`], allowedFiles: [], what: 'the system principal' },
  { rule: 'source-gate', module: `${API_SRC}/gate/source-gate`, allowedFolders: [`${API_SRC}/gate`], allowedFiles: [`${API_SRC}/start.ts`, `${API_SRC}/source-test/command.ts`], what: 'createSourceGate, which returns the system runner,' },
];

function isTestCode(path: string): boolean {
  return TEST_FILE.test(path) || isInside(path, `${API_SRC}/testing`);
}

function mayImport(capability: Capability, path: string): boolean {
  return capability.allowedFiles.includes(path) || capability.allowedFolders.some((folder) => isInside(path, folder));
}

/** The modules that hold the system principal and the system runner are imported only where the table says, and never re-exported. */
export function checkGateCapabilities(files: readonly SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    if (isTestCode(file.path)) continue;
    for (const ref of readImports(file.path, file.text)) {
      const resolved = resolveRelative(file.path, ref.specifier);
      if (resolved === undefined) continue;
      for (const capability of CAPABILITIES) {
        if (!isFileModule(resolved, capability.module)) continue;
        if (!mayImport(capability, file.path)) {
          violations.push({ rule: capability.rule, file: file.path, line: ref.line, specifier: ref.specifier, reason: `only ${capability.allowedFolders.concat(capability.allowedFiles).join(', ')} may import ${capability.what}` });
        } else if (ref.reexport) {
          violations.push({ rule: capability.rule, file: file.path, line: ref.line, specifier: ref.specifier, reason: `${capability.what} is never re-exported` });
        }
      }
    }
  }
  return violations;
}
