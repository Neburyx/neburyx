import ts from 'typescript';
import { scriptKindOf } from '../architecture/imports.js';
import type { SourceFile } from '../architecture/tree.js';
import type { Identifier } from './packs.js';
import type { WordViolation } from './violations.js';

export function indexByName(identifiers: readonly Identifier[]): ReadonlyMap<string, readonly Identifier[]> {
  const byName = new Map<string, Identifier[]>();
  for (const identifier of identifiers) {
    byName.set(identifier.name, [...(byName.get(identifier.name) ?? []), identifier]);
  }
  return byName;
}

function usesOf(identifiers: readonly Identifier[]): string[] {
  const packsByKind = new Map<string, Set<string>>();
  for (const identifier of identifiers) packsByKind.set(identifier.kind, (packsByKind.get(identifier.kind) ?? new Set<string>()).add(identifier.pack));
  return [...packsByKind].map(([kind, packs]) => `${kind} in ${[...packs].join(' and ')}`);
}

const NAMED_REFERENCES: Readonly<Record<string, string>> = { quot: '"', apos: "'", amp: '&', lt: '<', gt: '>' };

function decodeReferences(text: string): string {
  return text.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|(\w+));/g, (whole, decimal?: string, hex?: string, named?: string) => {
    const code = decimal !== undefined ? Number(decimal) : hex !== undefined ? parseInt(hex, 16) : undefined;
    if (code !== undefined) return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    return NAMED_REFERENCES[named ?? ''] ?? whole;
  });
}

function valueOf(node: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral): string {
  return ts.isStringLiteral(node) && ts.isJsxAttribute(node.parent) ? decodeReferences(node.text) : node.text;
}

export function findIdentifierLiterals(file: SourceFile, byName: ReadonlyMap<string, readonly Identifier[]>): WordViolation[] {
  const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true, scriptKindOf(file.path));
  const found: WordViolation[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const value = valueOf(node);
      const identifiers = byName.get(value);
      if (identifiers !== undefined) {
        found.push({ file: file.path, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, word: value, uses: usesOf(identifiers) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}
