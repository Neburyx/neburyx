import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { mayNameTarget } from './imports.js';
import type { SourceFile } from './tree.js';

export const WEB_SOURCE_ROOT = 'apps/web/src';
export const WEB_API_FOLDER = 'apps/web/src/api';

export const WEB_RENDERER_MODULE = 'apps/web/src/canvas/cytoscape-renderer.ts';

export type WebRule = 'web-fetch' | 'web-wire-type' | 'web-query-text' | 'web-database-dependency' | 'web-renderer-import';

export interface WebViolation {
  readonly rule: WebRule;
  readonly file: string;
  readonly line: number;
  readonly reason: string;
}

const WIRE_NAME_SUFFIX = /(?:Response|Request|Payload|Body|Dto)$/;
const CYPHER = /\b(?:OPTIONAL MATCH|MATCH|MERGE|CREATE|RETURN|WITH|UNWIND|SET|REMOVE|DETACH|DELETE|CALL|LOAD CSV)[ \t]+(?:[(\[{]|[A-Za-z_]|\d)/;
const DATABASE_PACKAGE = /neo4j|cypher|bolt|^pg$|postgres|kysely|mongodb|mysql|sqlite|redis|valkey/i;
const RENDERER_PACKAGE = /^cytoscape(?:\/|$)/;
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

function importedModule(node: ts.Node): string | undefined {
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) return node.argument.literal.text;
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteralLike(node.moduleReference.expression)) return node.moduleReference.expression.text;
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined && ts.isStringLiteralLike(node.moduleSpecifier)) return node.moduleSpecifier.text;
  if (ts.isCallExpression(node)) {
    const [first] = node.arguments;
    const loads = node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require');
    if (loads && first !== undefined && ts.isStringLiteralLike(first)) return first.text;
  }
  return undefined;
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

/** A name that ends in one of the wire suffixes, found in text. */
const WIRE_SUFFIX_IN_TEXT = /(?:Response|Request|Payload|Body|Dto)(?![\w$])/;
const NAMES_THE_RENDERER = /cytoscape/;
const NAMES_A_FETCH = /fetch/;
const DECLARES_A_TYPE = /\b(?:interface|type)\b/;
// a file can hold query text only if it holds one of the words a query starts with, in capitals; no word boundary, because a control escape in front of the word (`'\nMATCH (n)'`) leaves a letter beside it in the text, and LOAD alone, because the space of LOAD CSV can be an escape
const NAMES_A_QUERY_WORD = /MATCH|MERGE|CREATE|RETURN|WITH|UNWIND|SET|REMOVE|DETACH|DELETE|CALL|LOAD/;

function namePattern(names: ReadonlySet<string>): RegExp {
  const escaped = [...names].map((name) => name.replace(/[$\\^.*+?()[\]{}|/-]/g, '\\$&'));
  return new RegExp(`${WIRE_SUFFIX_IN_TEXT.source}|(?<![\\w$])(?:${escaped.join('|')})(?![\\w$])`);
}

/** The rules a file can break, by what its text holds; a file whose text holds none of the words a rule looks for (or an escape that could spell one) is not parsed for it, so it is not parsed at all. Reads the same files, with the same findings, as a full parse. */
function rulesFor(text: string, tests: boolean, wireNames: RegExp): { readonly renderer: boolean; readonly fetch: boolean; readonly wire: boolean; readonly query: boolean } {
  return {
    renderer: mayNameTarget(text, NAMES_THE_RENDERER),
    fetch: !tests && mayNameTarget(text, NAMES_A_FETCH),
    wire: !tests && mayNameTarget(text, DECLARES_A_TYPE) && mayNameTarget(text, wireNames),
    query: !tests && mayNameTarget(text, NAMES_A_QUERY_WORD),
  };
}

export function checkWebClient(files: readonly SourceFile[], contracts: ReadonlySet<string>): WebViolation[] {
  const violations: WebViolation[] = [];
  const wireNames = namePattern(contracts);
  for (const source of files) {
    if (!source.path.startsWith(`${WEB_SOURCE_ROOT}/`)) continue;
    const tests = isTestFile(source.path);
    const may = rulesFor(source.text, tests, wireNames);
    if (!may.renderer && !may.fetch && !may.wire && !may.query) continue;
    const file = ts.createSourceFile(source.path, source.text, ts.ScriptTarget.Latest, true, kindOf(source.path));
    const insideClient = source.path.startsWith(`${WEB_API_FOLDER}/`);
    const visit = (node: ts.Node): void => {
      const imported = importedModule(node);
      if (imported !== undefined && RENDERER_PACKAGE.test(imported) && source.path !== WEB_RENDERER_MODULE) {
        violations.push({ rule: 'web-renderer-import', file: source.path, line: lineOf(file, node), reason: `the renderer '${imported}' is imported only by ${WEB_RENDERER_MODULE}, so the canvas can swap it` });
      }
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
