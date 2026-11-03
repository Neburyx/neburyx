import ts from 'typescript';
import { scriptKindOf } from '../architecture/imports.js';
import type { SourceFile } from '../architecture/tree.js';

export interface EnvRead {
  readonly file: string;
  readonly line: number;
  readonly name: string | undefined;
  readonly key: string;
}

type Constant = string | ReadonlyMap<string, string>;

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isAsExpression(current) || ts.isParenthesizedExpression(current) || ts.isSatisfiesExpression(current) || ts.isNonNullExpression(current)) current = current.expression;
  return current;
}

function textOf(node: ts.Expression): string | undefined {
  const inner = unwrap(node);
  return ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner) ? inner.text : undefined;
}

function bindingNames(name: ts.BindingName, into: string[]): void {
  if (ts.isIdentifier(name)) {
    into.push(name.text);
    return;
  }
  for (const element of name.elements) if (!ts.isOmittedExpression(element)) bindingNames(element.name, into);
}

function isAssignmentTarget(access: ts.Node): boolean {
  const parent = access.parent;
  if (ts.isBinaryExpression(parent)) return parent.left === access && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
  if (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) return parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken;
  return ts.isDeleteExpression(parent);
}

function isDeclarationOrMemberName(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  if (ts.isPropertyAccessExpression(parent)) return parent.name === identifier;
  if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent) || ts.isMethodDeclaration(parent)) return parent.name === identifier;
  return false;
}

/** An object of constants is trusted only when every use of it is reading one of its properties. */
function onlyReadFrom(source: ts.SourceFile, name: string): boolean {
  let clean = true;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === name && !isDeclarationOrMemberName(node)) {
      const parent = node.parent;
      const reads = (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node && !isAssignmentTarget(parent);
      if (!reads) clean = false;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return clean;
}

/** How many times each name is declared anywhere in the file (variables, parameters, functions, classes, imports), so a name that is shadowed or redeclared is not trusted. */
function declarationCounts(source: ts.SourceFile): Map<string, number> {
  const counts = new Map<string, number>();
  const add = (name: string): void => void counts.set(name, (counts.get(name) ?? 0) + 1);
  const visit = (node: ts.Node): void => {
    const names: string[] = [];
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) bindingNames(node.name, names);
    else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name !== undefined) names.push(node.name.text);
    else if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) names.push(node.name.text);
    else if (ts.isImportClause(node) && node.name !== undefined) names.push(node.name.text);
    names.forEach(add);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return counts;
}

function constantsOf(source: ts.SourceFile): Map<string, Constant> {
  const counts = declarationCounts(source);
  const constants = new Map<string, Constant>();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined || counts.get(declaration.name.text) !== 1) continue;
      const text = textOf(declaration.initializer);
      const initializer = unwrap(declaration.initializer);
      if (text !== undefined) constants.set(declaration.name.text, text);
      else if (ts.isObjectLiteralExpression(initializer) && onlyReadFrom(source, declaration.name.text)) {
        const properties = new Map<string, string>();
        for (const property of initializer.properties) {
          if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) continue;
          const value = textOf(property.initializer);
          if (value !== undefined) properties.set(property.name.text, value);
        }
        constants.set(declaration.name.text, properties);
      }
    }
  }
  return constants;
}

function isEnvironment(node: ts.Expression): boolean {
  return (ts.isIdentifier(node) && node.text === 'env') || (ts.isPropertyAccessExpression(node) && node.name.text === 'env');
}

function resolve(key: ts.Expression, constants: ReadonlyMap<string, Constant>): string | undefined {
  const literal = textOf(key);
  if (literal !== undefined) return literal;
  const inner = unwrap(key);
  if (ts.isIdentifier(inner)) {
    const constant = constants.get(inner.text);
    return typeof constant === 'string' ? constant : undefined;
  }
  if (ts.isPropertyAccessExpression(inner) && ts.isIdentifier(inner.expression)) {
    const constant = constants.get(inner.expression.text);
    return typeof constant === 'object' ? constant.get(inner.name.text) : undefined;
  }
  return undefined;
}

export function collectEnvReads(file: SourceFile): EnvRead[] {
  const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true, scriptKindOf(file.path));
  const constants = constantsOf(source);
  const reads: EnvRead[] = [];
  const lineOf = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const visit = (node: ts.Node): void => {
    if (ts.isElementAccessExpression(node) && isEnvironment(unwrap(node.expression))) {
      reads.push({ file: file.path, line: lineOf(node), name: resolve(node.argumentExpression, constants), key: node.argumentExpression.getText(source) });
    } else if (ts.isPropertyAccessExpression(node) && isEnvironment(unwrap(node.expression))) {
      reads.push({ file: file.path, line: lineOf(node), name: node.name.text, key: node.name.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return reads;
}
