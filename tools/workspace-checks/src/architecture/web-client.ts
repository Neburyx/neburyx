import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import type { SourceFile } from './tree.js';

export const WEB_SOURCE_ROOT = 'apps/web/src';
export const WEB_API_FOLDER = 'apps/web/src/api';

export type WebRule = 'web-fetch' | 'web-wire-type' | 'web-query-text' | 'web-database-dependency';

export interface WebViolation {
  readonly rule: WebRule;
  readonly file: string;
  readonly line: number;
  readonly reason: string;
}

const WIRE_NAME_SUFFIX = /(?:Response|Request|Payload|Body|Dto)$/;
const CYPHER = /\b(?:OPTIONAL MATCH|MATCH|MERGE|CREATE|RETURN|WITH|UNWIND|SET|REMOVE|DETACH|DELETE|CALL|LOAD CSV)[ \t]+(?:[(\[{]|[A-Za-z_]|\d)/;
const DATABASE_PACKAGE = /neo4j|cypher|bolt|^pg$|postgres|kysely|mongodb|mysql|sqlite|redis|valkey/i;
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;

function isTestFile(path: string): boolean {
  return /\.test\.[cm]?[jt]sx?$/.test(path);
}

function kindOf(path: string): ts.ScriptKind {
  return path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function lineOf(file: ts.SourceFile, node: ts.Node): number {
  return file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
}

function isFetchOfApi(node: ts.CallExpression): boolean {
  const callee = node.expression;
  const isFetch = (ts.isIdentifier(callee) && callee.text === 'fetch') || (ts.isPropertyAccessExpression(callee) && callee.name.text === 'fetch');
  const first = node.arguments[0];
  if (!isFetch || first === undefined) return false;
  const text = ts.isStringLiteralLike(first) ? first.text : ts.isTemplateExpression(first) ? first.head.text : undefined;
  return text !== undefined && /^\/v1(?:\/|$|\?)/.test(text);
}

function isObjectShaped(node: ts.TypeNode): boolean {
  if (ts.isTypeLiteralNode(node)) return true;
  return ts.isIntersectionTypeNode(node) && node.types.some(isObjectShaped);
}

/** Reads the names a contracts entry file exports, from its `export { … } from` and `export type { … } from` lines. */
export function contractsExports(entryText: string): ReadonlySet<string> {
  const file = ts.createSourceFile('index.ts', entryText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = new Set<string>();
  for (const statement of file.statements) {
    if (ts.isExportDeclaration(statement) && statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) names.add(element.name.text);
    }
  }
  return names;
}

export function checkWebClient(files: readonly SourceFile[], contracts: ReadonlySet<string>): WebViolation[] {
  const violations: WebViolation[] = [];
  for (const source of files) {
    if (!source.path.startsWith(`${WEB_SOURCE_ROOT}/`)) continue;
    const tests = isTestFile(source.path);
    const file = ts.createSourceFile(source.path, source.text, ts.ScriptTarget.Latest, true, kindOf(source.path));
    const insideClient = source.path.startsWith(`${WEB_API_FOLDER}/`);
    const visit = (node: ts.Node): void => {
      if (!tests && !insideClient && ts.isCallExpression(node) && isFetchOfApi(node)) {
        violations.push({ rule: 'web-fetch', file: source.path, line: lineOf(file, node), reason: 'the web client reads the API only through the API client folder' });
      }
      if (!tests && ts.isInterfaceDeclaration(node)) {
        if (WIRE_NAME_SUFFIX.test(node.name.text) || contracts.has(node.name.text)) violations.push({ rule: 'web-wire-type', file: source.path, line: lineOf(file, node), reason: `'${node.name.text}' is a hand-written second type for an API shape; derive it from a contracts schema` });
      }
      if (!tests && ts.isTypeAliasDeclaration(node) && isObjectShaped(node.type)) {
        if (WIRE_NAME_SUFFIX.test(node.name.text) || contracts.has(node.name.text)) violations.push({ rule: 'web-wire-type', file: source.path, line: lineOf(file, node), reason: `'${node.name.text}' is a hand-written second type for an API shape; derive it from a contracts schema` });
      }
      if (!tests && (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node))) {
        const text = ts.isJsxText(node) ? node.text : node.text;
        if (CYPHER.test(text)) violations.push({ rule: 'web-query-text', file: source.path, line: lineOf(file, node), reason: 'query text never appears in the web client' });
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return violations;
}

export function checkWebDependencies(packageJsonText: string, path = 'apps/web/package.json'): WebViolation[] {
  const parsed: unknown = JSON.parse(packageJsonText);
  const violations: WebViolation[] = [];
  for (const field of DEPENDENCY_FIELDS) {
    const group: unknown = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, field) : undefined;
    if (typeof group !== 'object' || group === null) continue;
    for (const name of Object.keys(group)) {
      if (DATABASE_PACKAGE.test(name)) violations.push({ rule: 'web-database-dependency', file: path, line: 1, reason: `the web client depends on '${name}', a graph or database client` });
    }
  }
  return violations;
}

export function readWebPackageJson(root: string): string {
  return readFileSync(join(root, 'apps/web/package.json'), 'utf8');
}

export function formatWebViolations(violations: readonly WebViolation[]): string {
  return violations.map((v) => `${v.file}:${v.line}: ${v.reason} [${v.rule}]`).join('\n');
}
