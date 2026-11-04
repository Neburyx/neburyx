import ts from 'typescript';
import { scriptKindOf } from './imports.js';
import type { SourceFile } from './tree.js';
import type { Violation } from './violations.js';

export const CONTAINER_SCAN_ROOTS: readonly string[] = ['services', 'apps', 'packages', 'tools', 'ee'];

const HELPER = 'startWithRetry';
const CONTAINER_CLASS = /Container$/;

type Scope = Map<string, boolean>;

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current) || ts.isAsExpression(current) || ts.isAwaitExpression(current)) current = current.expression;
  return current;
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) => (ts.isOmittedExpression(element) ? [] : bindingNames(element.name)));
}

function opensScope(node: ts.Node): boolean {
  return ts.isSourceFile(node) || ts.isBlock(node) || ts.isCaseBlock(node) || ts.isFunctionLike(node) || ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node) || ts.isCatchClause(node);
}

function startsWithContainer(expression: ts.Expression, holds: (name: string) => boolean): boolean {
  let current = unwrap(expression);
  for (;;) {
    if (ts.isNewExpression(current)) return ts.isIdentifier(current.expression) && CONTAINER_CLASS.test(current.expression.text);
    if (ts.isIdentifier(current)) return holds(current.text);
    if (ts.isCallExpression(current) || ts.isPropertyAccessExpression(current)) current = unwrap(current.expression);
    else return false;
  }
}

export function checkContainerStarts(files: readonly SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    if (!/Container\b/.test(file.text)) continue;
    const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true, scriptKindOf(file.path));
    const scopes: Scope[] = [];
    const nearest = (name: string): Scope | undefined => scopes.findLast((scope) => scope.has(name));
    const holds = (name: string): boolean => nearest(name)?.get(name) === true;
    const scopeNodes: ts.Node[] = [];
    const declare = (names: readonly string[], holder: boolean, hoisted: boolean): void => {
      const index = hoisted ? scopeNodes.findLastIndex((scope) => ts.isSourceFile(scope) || ts.isFunctionLike(scope)) : scopes.length - 1;
      for (const name of names) scopes[index]?.set(name, holder);
    };
    const visit = (node: ts.Node, retried: boolean): void => {
      const opens = opensScope(node);
      const outer = opens && ts.isFunctionLike(node) ? scopes.map((scope) => new Map(scope)) : undefined;
      if (opens) {
        scopes.push(new Map());
        scopeNodes.push(node);
      }
      if (ts.isParameter(node)) declare(bindingNames(node.name), false, false);
      if (ts.isVariableDeclaration(node)) declare(bindingNames(node.name), ts.isIdentifier(node.name) && node.initializer !== undefined && startsWithContainer(node.initializer, holds), ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.BlockScoped) === 0);
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) nearest(node.left.text)?.set(node.left.text, startsWithContainer(node.right, holds));
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'start' && node.arguments.length === 0 && !retried && startsWithContainer(node.expression.expression, holds)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        violations.push({ rule: 'container-start', file: file.path, line: line + 1, specifier: 'a container .start() call', reason: `start a container inside ${HELPER}, so that the port-binding timeout is retried` });
      }
      const inHelper = retried || (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === HELPER);
      ts.forEachChild(node, (child) => visit(child, inHelper));
      if (opens) {
        scopes.pop();
        scopeNodes.pop();
        outer?.forEach((saved, index) => {
          scopes[index]?.clear();
          saved.forEach((holder, name) => scopes[index]?.set(name, holder));
        });
      }
    };
    visit(source, false);
  }
  return violations;
}
