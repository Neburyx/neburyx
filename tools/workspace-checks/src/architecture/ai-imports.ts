import { readImports } from './imports.js';
import { isInside, resolveRelative } from './resolve.js';
import type { SourceFile } from './tree.js';
import type { Violation } from './violations.js';

interface AiPackage {
  readonly folder: string;
  readonly allowed: readonly string[];
}

/** The AI packages reach the core only through the gate client, so what they may import is a short list: their own files, Node built-ins and these packages. */
const AI_PACKAGES: readonly AiPackage[] = [
  { folder: 'ee/ai-runtime', allowed: ['@neburyx/contracts', '@neburyx/ee-audit', '@anthropic-ai/sdk'] },
  { folder: 'ee/ask', allowed: ['@neburyx/contracts', '@neburyx/ee-ai-runtime', '@neburyx/ee-audit', 'pg'] },
];

export const AI_IMPORT_SCAN_ROOTS: readonly string[] = ['ee'];

const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

const isProduction = (path: string): boolean => !TEST_FILE.test(path) && !path.split('/').includes('testing');

function packageNameOf(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

function reasonFor(owner: AiPackage, file: string, specifier: string): string | undefined {
  if (specifier.startsWith('.')) {
    const resolved = resolveRelative(file, specifier);
    return resolved !== undefined && isInside(resolved.path, `${owner.folder}/src`) ? undefined : `${owner.folder} imports only its own files`;
  }
  if (specifier.startsWith('node:')) return undefined;
  return owner.allowed.includes(packageNameOf(specifier)) ? undefined : `${owner.folder} may import only ${owner.allowed.join(', ')} and Node built-ins`;
}

export function checkAiImports(files: readonly SourceFile[], read: typeof readImports = readImports): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    const owner = AI_PACKAGES.find((candidate) => isInside(file.path, `${candidate.folder}/src`));
    if (owner === undefined || !isProduction(file.path)) continue;
    for (const ref of read(file.path, file.text)) {
      const reason = reasonFor(owner, file.path, ref.specifier);
      if (reason !== undefined) violations.push({ rule: 'ai-imports', file: file.path, line: ref.line, specifier: ref.specifier, reason });
    }
  }
  return violations;
}
