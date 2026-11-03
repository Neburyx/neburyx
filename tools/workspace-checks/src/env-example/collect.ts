import ts from 'typescript';
import { scriptKindOf } from '../architecture/imports.js';
import type { SourceFile } from '../architecture/tree.js';

export interface EnvRead {
  readonly file: string;
  readonly line: number;
  /** The variable name, or undefined for a read through a key the scan cannot resolve. */
  readonly name: string | undefined;
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

function constantsOf(source: ts.SourceFile): Map<string, Constant> {
  const constants = new Map<string, Constant>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      const text = textOf(node.initializer);
      const initializer = unwrap(node.initializer);
      if (text !== undefined) constants.set(node.name.text, text);
      else if (ts.isObjectLiteralExpression(initializer)) {
        const properties = new Map<string, string>();
        for (const property of initializer.properties) {
          if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) continue;
          const value = textOf(property.initializer);
          if (value !== undefined) properties.set(property.name.text, value);
        }
        constants.set(node.name.text, properties);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
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

/** Every read of an environment variable in a file: `env[key]`, `env.NAME`, `process.env.NAME` and `process.env[key]`. */
export function collectEnvReads(file: SourceFile): EnvRead[] {
  const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true, scriptKindOf(file.path));
  const constants = constantsOf(source);
  const reads: EnvRead[] = [];
  const lineOf = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const visit = (node: ts.Node): void => {
    if (ts.isElementAccessExpression(node) && isEnvironment(unwrap(node.expression))) {
      reads.push({ file: file.path, line: lineOf(node), name: resolve(node.argumentExpression, constants) });
    } else if (ts.isPropertyAccessExpression(node) && isEnvironment(unwrap(node.expression))) {
      reads.push({ file: file.path, line: lineOf(node), name: node.name.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return reads;
}
