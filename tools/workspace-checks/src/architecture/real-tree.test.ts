import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../workspace.js';
import { ADAPTER_SCAN_ROOTS, checkAdapterAccess } from './adapter.js';
import { checkGateCapabilities, GATE_CAPABILITY_SCAN_ROOTS } from './gate-capabilities.js';
import { createImportReader, readImports } from './imports.js';
import { loadTree } from './tree.js';
import { formatViolations } from './violations.js';
import { checkWebClient, checkWebDependencies, contractsExports, formatWebViolations, readWebPackageJson } from './web-client.js';

/*
 * The checks over the real tree live in one file, so that the tree is read once, TypeScript is loaded and warmed once, and a file
 * that two checks both need is parsed once. They were three files that each loaded and warmed TypeScript on a runner that is busy
 * with the other packages' tests, and each real-tree test came close to the five-second limit there.
 *
 * Measured on a development machine (550 files, 2.8 MB): about 0.13 s for the adapter check, 0.02 s for the gate capabilities and
 * 0.07 s for the web client, the same under six busy loops; before, 0.17 s, 0.16 s and 0.14 s, each in its own cold file. The CI log
 * of the unit job showed 2.8 to 5.6 s for the adapter check alone on a runner that runs the other packages' tests at the same time,
 * about thirty times the local figure. The limit below is that figure with a wide margin (7 times the worst CI time seen) so that a
 * busy runner does not fail the job, and the checks above do the work in far fewer files so that it is rarely needed.
 */
const REAL_TREE_TIMEOUT_MS = 30_000;
const API = 'services/api/src';
const files = loadTree(repoRoot, { include: ADAPTER_SCAN_ROOTS });
const parsed = new Set<string>();
const reader = createImportReader();
const read: typeof readImports = (fileName, text) => {
  parsed.add(fileName);
  return reader(fileName, text);
};

describe('the real repository tree', () => {
  it('reads the files the checks are meant to check', () => {
    expect(GATE_CAPABILITY_SCAN_ROOTS).toEqual(ADAPTER_SCAN_ROOTS);
    expect(files.map((file) => file.path)).toEqual(expect.arrayContaining([`${API}/gate/gate.ts`, `${API}/app.ts`]));
    expect(files.length).toBeGreaterThan(50);
  });

  it('has no way around the gate', () => {
    expect(formatViolations(checkAdapterAccess(files, read))).toBe('');
  }, REAL_TREE_TIMEOUT_MS);

  it('imports the system principal and createSourceGate only where it may, and re-exports neither', () => {
    expect(formatViolations(checkGateCapabilities(files, read))).toBe('');
  }, REAL_TREE_TIMEOUT_MS);

  it('parses a file only when its text could name a target, and only once for the two checks', () => {
    const production = files.filter((file) => !/\.test\.[cm]?[jt]sx?$/.test(file.path) && !file.path.startsWith(`${API}/testing/`));
    expect(parsed.size, 'no file was parsed, so the checks above read nothing').toBeGreaterThan(0);
    expect(parsed.size, `${parsed.size} of ${production.length} production files were parsed`).toBeLessThan(production.length * 0.6);
  });
});

describe('the real web client', () => {
  it('passes every check', () => {
    const web = loadTree(repoRoot, { include: ['apps/web/src'] });
    const contracts = contractsExports(readFileSync(join(repoRoot, 'packages/contracts/src/index.ts'), 'utf8'));
    expect(contracts.has('meResponseSchema')).toBe(true);
    const violations = [...checkWebClient(web, contracts), ...checkWebDependencies(readWebPackageJson(repoRoot))];
    expect(formatWebViolations(violations)).toBe('');
  }, REAL_TREE_TIMEOUT_MS);
});
