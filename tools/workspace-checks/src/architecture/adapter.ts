import { mayNameTarget, readImports, type ImportRef } from './imports.js';
import { isFileModule, isInside, isInsideDirectory, resolveRelative, withoutExtension } from './resolve.js';
import type { SourceFile } from './tree.js';
import type { Violation } from './violations.js';

export const ADAPTER_SCAN_ROOTS: readonly string[] = ['services', 'packages', 'apps', 'ee'];

const API_SRC = 'services/api/src';
const SOURCES_ZONE = `${API_SRC}/sources`;
const GATE_ZONE = `${API_SRC}/gate`;
const TESTING_ZONE = `${API_SRC}/testing`;
/** The one module outside gate/ and sources/ that may import a module under sources/, and the module it may import: the test-source command runs the write probe. */
const PROBE_IMPORTER = `${API_SRC}/source-test/command.ts`;
const PROBE_MODULE = `${SOURCES_ZONE}/write-probe`;
const EXECUTOR_MODULES: readonly string[] = [`${GATE_ZONE}/executor`, `${GATE_ZONE}/execute`, `${GATE_ZONE}/deps`, `${GATE_ZONE}/gate`, `${GATE_ZONE}/assemble`];
const DRIVER_PACKAGE = /^neo4j-driver(?:\/|$)/;
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const TEST_MODULE = /\.test$/;

/** A specifier that reaches a target holds one of these words (the driver package, a folder or module of the table above, a test module) unless an escape spells it, and a specifier that holds none (`'.'`, `'..'`) reaches the folder it is written in, so the importer's own path counts too; a file with none of them is not parsed. */
const NAMES_A_TARGET = /neo4j-driver|sources|testing|\.test|executor|execute|deps|gate|assemble|write-probe/;

type Target = 'driver' | 'sources' | 'executor' | 'test-code' | 'write-probe';

function targetOf(file: string, specifier: string): Target | undefined {
  if (DRIVER_PACKAGE.test(specifier)) return 'driver';
  const resolved = resolveRelative(file, specifier);
  if (resolved === undefined) return undefined;
  if (isInsideDirectory(resolved, TESTING_ZONE) || (resolved.kind !== 'index' && TEST_MODULE.test(resolved.path))) return 'test-code';
  if (isFileModule(resolved, PROBE_MODULE)) return 'write-probe';
  if (isInsideDirectory(resolved, SOURCES_ZONE)) return 'sources';
  if (EXECUTOR_MODULES.some((module) => isFileModule(resolved, module))) return 'executor';
  return undefined;
}

function isTestCode(path: string): boolean {
  return TEST_FILE.test(path) || isInside(path, TESTING_ZONE);
}

function isRestrictedModule(path: string): boolean {
  return isInside(path, SOURCES_ZONE) || EXECUTOR_MODULES.includes(withoutExtension(path));
}

function zoneReason(file: string, target: Target): string | undefined {
  const inSources = isInside(file, SOURCES_ZONE);
  const inGate = isInside(file, GATE_ZONE);
  if (target === 'test-code') return 'production code reaches test code';
  if (target === 'driver' && !inSources) return 'only the adapter under sources/ talks to the driver';
  if (target === 'write-probe') return inSources || inGate || file === PROBE_IMPORTER ? undefined : 'only the gate reaches the adapter';
  if ((target === 'sources' || target === 'executor') && !inSources && !inGate) return 'only the gate reaches the adapter';
  return undefined;
}

function reasonFor(file: string, ref: ImportRef, target: Target): string | undefined {
  const zone = zoneReason(file, target);
  // a binding forwarded out of a file was imported in that file, and a bad import is reported on its own
  if (zone !== undefined) return ref.form === 'reexport-binding' ? undefined : zone;
  if (ref.reexport && !isRestrictedModule(file)) return 'a restricted export is re-exported through a module that is not restricted';
  return undefined;
}

export function checkAdapterAccess(files: readonly SourceFile[], read: typeof readImports = readImports): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    if (isTestCode(file.path) || !(NAMES_A_TARGET.test(file.path) || mayNameTarget(file.text, NAMES_A_TARGET))) continue;
    for (const ref of read(file.path, file.text)) {
      const target = targetOf(file.path, ref.specifier);
      if (target === undefined) continue;
      const reason = reasonFor(file.path, ref, target);
      if (reason !== undefined) violations.push({ rule: 'adapter-access', file: file.path, line: ref.line, specifier: ref.specifier, reason });
    }
  }
  return violations;
}
